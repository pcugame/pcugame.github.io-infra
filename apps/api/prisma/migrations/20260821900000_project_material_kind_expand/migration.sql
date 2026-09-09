-- Enum values commit independently before constraints use them.
ALTER TYPE "AssetKind" ADD VALUE 'DOCUMENT';
ALTER TYPE "AssetKind" ADD VALUE 'ATTACHMENT';
ALTER TYPE "AssetUploadKind" ADD VALUE 'DOCUMENT';
ALTER TYPE "AssetUploadKind" ADD VALUE 'ATTACHMENT';
