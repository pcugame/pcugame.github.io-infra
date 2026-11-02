using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using CUE4Parse.UE4.Pak;
using CUE4Parse.UE4.Pak.Objects;
using CUE4Parse.UE4.IO;
using CUE4Parse.UE4.IO.Objects;
using CUE4Parse.UE4.Readers;
using CUE4Parse.UE4.Versions;
using CUE4Parse.UE4.Objects.UObject;
using CUE4Parse.UE4.Assets;

// Only metadata is read. No provider, downloaded codec, game DLL or UObject deserialization.
internal record Input(int Version, long AnalysisBytes, FileInput[] Files);
internal record FileInput(string Path, string LocalPath, long Bytes);
internal record Fact(string Path, string Format, string Status, string[] Evidence, string[] Reasons);
internal sealed class Corrupt(string reason) : Exception(reason);
internal sealed class Uncertain(string reason) : Exception(reason);
internal static class Program
{
    const string Revision = "605672df7a993a90094bad92d30c388d87ae6c1a";
    static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, PropertyNameCaseInsensitive = true };
    static long remaining;
    // Empty until a genuine loose export establishes a supported interpretation.
    static readonly HashSet<int> CertifiedLooseVersions = [];
    static void Spend(long size) { if (size < 0 || size > remaining) throw new Uncertain("ue-analysis-budget"); remaining -= size; }
    static void Range(long start, long size, long length) { if (start < 0 || size < 0 || start > length || size > length - start) throw new Corrupt("ue-range-outside-file"); }
    static void SafeVirtual(string path, bool mount = false)
    {
        // UE mount roots are virtual; never join these to a server filesystem path.
        if (mount && path.StartsWith("../../../", StringComparison.Ordinal)) path = path[9..];
        if (path.Contains('\\') || path.Contains('\0') || path.StartsWith('/') || path.Contains(':') || path.Split('/').Any(p => p == "..")) throw new Corrupt("ue-virtual-path-escape");
    }
    static byte[] Bytes(FArchive ar, long offset, long length) { Range(offset, length, ar.Length); Spend(length); ar.Position = offset; return ar.ReadBytes(checked((int)length)); }
    static void HashRange(FArchive ar, long offset, long size, string hash)
    {
        var bytes = Bytes(ar, offset, size);
        if (Convert.ToHexString(SHA1.HashData(bytes)) != hash) throw new Corrupt("ue-pak-index-hash-mismatch");
    }
    static void Pak(FileInput file, List<string> evidence)
    {
        // Explicit stable standard-container interpretation, never library latest defaults.
        using var pak = new PakFileReader(file.LocalPath, new VersionContainer(EGame.GAME_UE4_26));
        var info = pak.Info;
        if (info.Magic != FPakInfo.PAK_FILE_MAGIC || (int)info.Version < 1 || (int)info.Version > 11 || info.IndexIsFrozen) throw new Uncertain("ue-pak-version-or-custom-format");
        Range(info.IndexOffset, info.IndexSize, pak.Ar.Length);
        if (info.EncryptedIndex) throw new Uncertain("ue-encrypted-index");
        HashRange(pak.Ar, info.IndexOffset, info.IndexSize, info.IndexHash.ToString());
        using (var primary = new FByteArchive("index", Bytes(pak.Ar, info.IndexOffset, info.IndexSize), pak.Versions))
        {
            SafeVirtual(primary.ReadFString(), true);
            var count = primary.Read<int>();
            if (count < 0) throw new Corrupt("ue-pak-negative-entry-count");
            if (count > 100000) throw new Uncertain("ue-entry-budget");
            if ((int)info.Version >= 10)
            {
                primary.Position += 8;
                for (var i = 0; i < 2; i++)
                {
                    if (!primary.ReadBoolean()) throw new Uncertain("ue-pak-pruned-index");
                    var offset = primary.Read<long>(); var size = primary.Read<long>();
                    var hash = Convert.ToHexString(primary.ReadBytes(20));
                    HashRange(pak.Ar, offset, size, hash);
                }
            }
        }
        pak.Mount(StringComparer.Ordinal);
        var encryptedContent = false;
        foreach (var (path, value) in pak.Files)
        {
            SafeVirtual(path);
            if (value is not FPakEntry entry) throw new Uncertain("ue-pak-entry-type");
            if (entry.IsDeleted) continue;
            Range(entry.Offset, entry.StructSize, info.IndexOffset);
            Range(entry.Offset + entry.StructSize, entry.CompressedSize, info.IndexOffset);
            if (entry.UncompressedSize < 0) throw new Corrupt("ue-pak-negative-size");
            foreach (var block in entry.CompressionBlocks) Range(block.CompressedStart, block.CompressedEnd - block.CompressedStart, info.IndexOffset);
            encryptedContent |= entry.IsEncrypted;
        }
        evidence.Add($"Pak v{(int)info.Version}: primary/auxiliary SHA1 and {pak.Files.Count} entry ranges checked");
        evidence.Add($"Virtual mount: {pak.MountPoint}");
        if (encryptedContent) throw new Uncertain("ue-encrypted-content");
        // Package payload/codec and project binding certification is a separate release gate.
        throw new Uncertain("ue-pak-cooked-payload-not-certified");
    }
    static void Io(FileInput file, Dictionary<string, FileInput> files, List<string> evidence)
    {
        using var headerAr = new FStreamArchive(file.Path, File.OpenRead(file.LocalPath), new VersionContainer(EGame.GAME_UE5_0));
        if (file.Bytes < FIoStoreTocHeader.SIZE) throw new Uncertain("ue-unrecognized-or-truncated-utoc");
        var header = new FIoStoreTocHeader(headerAr);
        if (header.Version < EIoStoreTocVersion.Initial || header.Version > EIoStoreTocVersion.PerfectHashWithOverflow) throw new Uncertain("ue-utoc-version");
        if (header.TocHeaderSize != 144 || header.TocCompressedBlockEntrySize != 12) throw new Uncertain("ue-utoc-custom-layout");
        var partitions = header.Version < EIoStoreTocVersion.PartitionSize ? 1 : header.PartitionCount;
        if (partitions > 1024) throw new Uncertain("ue-partition-budget");
        if (partitions == 0 || header.CompressionBlockSize == 0 || (header.Version >= EIoStoreTocVersion.PartitionSize && header.PartitionSize == 0)) throw new Corrupt("ue-utoc-invalid-partitions-or-block-size");
        var basePath = file.Path[..^5];
        for (var i = 0; i < partitions; i++)
            if (!files.ContainsKey(basePath + (i == 0 ? "" : $"_s{i}") + ".ucas")) throw new Corrupt("ue-missing-ucas-partition");
        Range(144, (long)header.TocEntryCount * 22 + (long)header.TocCompressedBlockEntryCount * 12 + (long)header.CompressionMethodNameCount * header.CompressionMethodNameLength + header.DirectoryIndexSize, file.Bytes);
        if (header.CompressionMethodNameCount > 32 || header.CompressionMethodNameLength > 64 || header.TocEntryCount > 100000 || header.TocCompressedBlockEntryCount > 1000000) throw new Uncertain("ue-toc-table-budget");
        Spend(file.Bytes);
        headerAr.Position = 0;
        using var io = new IoStoreReader(headerAr, path => new FStreamArchive(path, File.OpenRead(files[path].LocalPath), headerAr.Versions), EIoStoreTocReadOptions.ReadAll);
        var toc = io.TocResource;
        foreach (var block in toc.CompressionBlocks)
        {
            if (block.CompressionMethodIndex >= toc.CompressionMethods.Length || block.UncompressedSize > header.CompressionBlockSize || block.UncompressedSize == 0) throw new Corrupt("ue-utoc-invalid-block");
            var partition = (int)((ulong)block.Offset / toc.Header.PartitionSize);
            var offset = (long)((ulong)block.Offset % toc.Header.PartitionSize);
            if (partition >= io.ContainerStreams.Count) throw new Corrupt("ue-utoc-partition-reference");
            var stored = header.ContainerFlags.HasFlag(EIoContainerFlags.Encrypted) ? ((long)block.CompressedSize + 15) / 16 * 16 : block.CompressedSize;
            Range(offset, stored, io.ContainerStreams[partition].Length);
        }
        foreach (var chunk in toc.ChunkOffsetLengths)
            Range((long)chunk.Offset, (long)chunk.Length, (long)toc.CompressionBlocks.Length * header.CompressionBlockSize);
        evidence.Add($"IoStore v{(int)header.Version}: {partitions} partitions, {toc.ChunkIds.Length} chunks, {toc.CompressionBlocks.Length} blocks checked");
        if (io.IsEncrypted) throw new Uncertain("ue-encrypted-content");
        if (!io.HasDirectoryIndex) throw new Uncertain("ue-global-container-metadata-not-certified");
        io.Mount(StringComparer.Ordinal);
        foreach (var path in io.Files.Keys) SafeVirtual(path);
        evidence.Add($"IoStore directory: {io.Files.Count} entries");
        throw new Uncertain("ue-iostore-package-metadata-not-certified");
    }
    static void Loose(FileInput file, Dictionary<string, FileInput> files, List<string> evidence)
    {
        using var ar = new FStreamArchive(file.Path, File.OpenRead(file.LocalPath), new VersionContainer(EGame.GAME_UE4_26));
        if (file.Bytes < 20 || ar.Read<uint>() != FPackageFileSummary.PACKAGE_FILE_TAG) throw new Uncertain("ue-unrecognized-package");
        var legacy = ar.Read<int>(); ar.Position += 4;
        var ue4 = ar.Read<int>(); var ue5 = legacy <= -8 ? ar.Read<int>() : 0;
        if (legacy != -7 || ue4 == 0 || ue5 != 0) throw new Uncertain("ue-package-version-unverified");
        if (!CertifiedLooseVersions.Contains(ue4)) throw new Uncertain("ue-loose-version-not-certified");
        Spend(file.Bytes);
        ar.Position = 0;
        var summary = new FPackageFileSummary(ar);
        if (!summary.PackageFlags.HasFlag(EPackageFlags.PKG_Cooked)) throw new Uncertain("ue-editor-or-uncooked-package");
        Range(0, summary.TotalHeaderSize, file.Bytes);
        foreach (var (offset, count, minSize) in new[] { (summary.NameOffset, summary.NameCount, 4), (summary.ImportOffset, summary.ImportCount, 28), (summary.ExportOffset, summary.ExportCount, 1) })
            Range(offset, (long)count * minSize, summary.TotalHeaderSize);
        var external = file.Path[..file.Path.LastIndexOf('.')] + ".uexp";
        files.TryGetValue(external, out var uexp);
        using var expAr = uexp == null ? null : new FStreamArchive(external, File.OpenRead(uexp.LocalPath), ar.Versions);
        ar.Position = 0;
        var package = new Package(ar, expAr, ubulk: (FArchive?)null);
        foreach (var export in package.ExportMap)
        {
            if (uexp == null) Range(export.SerialOffset, export.SerialSize, file.Bytes);
            else Range(export.SerialOffset - summary.TotalHeaderSize, export.SerialSize, uexp.Bytes);
        }
        evidence.Add($"Cooked package: {summary.ExportCount} exports and summary table ranges checked");
        throw new Uncertain("ue-loose-bulk-data-binding-not-certified");
    }
    public static int Main(string[] args)
    {
        try
        {
            if (args.Length != 1 || new FileInfo(args[0]).Length > 1024 * 1024) return 2;
            var input = JsonSerializer.Deserialize<Input>(File.ReadAllText(args[0]), Json) ?? throw new Exception();
            if (input.Version != 1 || input.AnalysisBytes < 1 || input.AnalysisBytes > 32 * 1024 * 1024 || input.Files.Length > 10000) return 2;
            remaining = input.AnalysisBytes;
            var files = input.Files.ToDictionary(f => f.Path, StringComparer.Ordinal);
            foreach (var file in input.Files)
                if (!Path.IsPathFullyQualified(file.LocalPath) || new FileInfo(file.LocalPath).Length != file.Bytes) return 2;
            var facts = new List<Fact>();
            foreach (var file in input.Files)
            {
                var ext = Path.GetExtension(file.Path).ToLowerInvariant();
                var format = ext == ".pak" ? "pak" : ext == ".utoc" ? "iostore" : ext is ".uasset" or ".umap" ? "loose" : null;
                if (format == null) continue;
                var evidence = new List<string>(); string status = "review"; string reason;
                try
                {
                    if (format == "pak") Pak(file, evidence);
                    else if (format == "iostore") Io(file, files, evidence);
                    else Loose(file, files, evidence);
                    reason = "ue-format-not-certified";
                }
                catch (Corrupt e) { status = "reject"; reason = e.Message; }
                catch (Uncertain e) { reason = e.Message; }
                catch (OutOfMemoryException) { return 3; }
                catch (IOException e) when (e is not EndOfStreamException) { return 2; }
                catch (Exception) { reason = "ue-parser-unsupported-or-inconclusive"; }
                facts.Add(new Fact(file.Path, format, status, evidence.ToArray(), [reason]));
            }
            Console.Write(JsonSerializer.Serialize(new { version = 1, inspector = "ue-inspector-v1", parserRevision = Revision, facts }, Json));
            return 0;
        }
        catch { return 2; } // Protocol/filesystem failures are infrastructure retry, never content rejection.
    }
}
