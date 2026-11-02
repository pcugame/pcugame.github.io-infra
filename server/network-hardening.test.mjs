import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./hardening/install-network-hardening.sh', import.meta.url));
const resolveCommand = name => {
  const result = spawnSync('bash', ['-c', 'command -v "$1"', '--', name], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const bash = resolveCommand('bash');
const cat = resolveCommand('cat');

function run(args, { packagesAvailable = true, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pcu-network-hardening-'));
  try {
    const bin = join(dir, 'bin');
    const trace = join(dir, 'trace');
    mkdirSync(bin);
    writeFileSync(trace, '');
    symlinkSync(cat, join(bin, 'cat'));
    // A closed PATH prevents fallback to host tools. Stop at install before any
    // shell redirection to /etc, even when these tests are run as root.
    for (const command of ['apt-get', 'nft', 'systemctl', 'fail2ban-client', 'install', 'cp', 'date', 'grep']) {
      if (command === 'apt-get' && !packagesAvailable) continue;
      writeFileSync(join(bin, command), `#!${bash}
printf '%s|%s|%s\\n' '${command}' "$*" "\${DEBIAN_FRONTEND:-}" >> "$TEST_TRACE"
${command === 'apt-get' ? 'exit 0' : 'exit 97'}
`, { mode: 0o755 });
    }
    const result = spawnSync(bash, [script, ...args], {
      encoding: 'utf8', timeout: 5000,
      env: { PATH: bin, TEST_TRACE: trace, TMPDIR: dir, ...env },
    });
    assert.ifError(result.error);
    return { ...result, trace: readFileSync(trace, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const packagesAvailable of [true, false]) {
  for (const args of [
    ['--dry-run'],
    ['--dry-run', '--install-packages'],
    ['--install-packages', '--dry-run'],
  ]) {
    test(`${args.join(' ')} renders without commands (apt available: ${packagesAvailable})`, () => {
      const result = run(args, { packagesAvailable });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.trace, '');
      assert.equal(result.stderr, '');
      assert.match(result.stdout, /port = 5050/);
      assert.match(result.stdout, /iifname != "lo" tcp dport 4000 drop/);
      assert.match(result.stdout, /udp dport 111 drop/);
      assert.equal(result.stdout, run(['--dry-run']).stdout);
    });
  }
}

test('combined dry-run retains environment configuration', () => {
  const result = run(['--install-packages', '--dry-run'], { env: {
    SSH_PORT: '2222', API_PORT: '4444', PUBLIC_IFACE: 'eth-test',
    SSH_RATE_LIMIT: '6/minute', SSH_RATE_BURST: '9',
    FAIL2BAN_MAXRETRY: '3', FAIL2BAN_FINDTIME: '5m', FAIL2BAN_BANTIME: '2h',
  } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.trace, '');
  for (const expected of ['port = 2222', 'maxretry = 3', 'findtime = 5m', 'bantime = 2h',
    'iifname "eth-test" tcp dport 2222 ct state new limit rate over 6/minute burst 9 packets drop',
    'iifname "eth-test" tcp dport 4444 drop']) assert.ok(result.stdout.includes(expected), expected);
});

for (const option of ['-h', '--help', '--unknown']) {
  test(`CLI ${option} exits before commands`, () => {
    const result = run(['--install-packages', option]);
    assert.equal(result.status, option === '--unknown' ? 2 : 0);
    assert.equal(result.trace, '');
    assert.match(result.stdout + result.stderr, /Usage:/);
  });
}

test('normal execution still requires root', { skip: process.getuid() === 0 }, () => {
  for (const args of [[], ['--install-packages']]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /run as root/);
    assert.equal(result.trace, '');
  }
});

test('normal root execution installs packages before configuration', { skip: process.getuid() !== 0 }, () => {
  const result = run(['--install-packages']);
  assert.equal(result.status, 97);
  assert.equal(result.trace, 'apt-get|update|\napt-get|install -y fail2ban nftables|noninteractive\ninstall|-d -m 0755 /etc/fail2ban/jail.d /etc/nftables.d|\n');
  const withoutPackages = run([]);
  assert.equal(withoutPackages.status, 97);
  assert.equal(withoutPackages.trace, 'install|-d -m 0755 /etc/fail2ban/jail.d /etc/nftables.d|\n');
  const unsupported = run(['--install-packages'], { packagesAvailable: false });
  assert.equal(unsupported.status, 1);
  assert.match(unsupported.stderr, /supports apt-get hosts only/);
  assert.equal(unsupported.trace, '');
});
