// Public-source fingerprints only. No Zylos modules are imported or executed.
// Derived from the official v0.5.2 tag; a match is not a runtime capability grant.
export const ZYLOS_UPSTREAM = Object.freeze({
  repository: 'https://github.com/zylos-ai/zylos-core',
  tag: 'v0.5.2', version: '0.5.2', commit: '8ee9bd9007edab46f766f3574e0ad56cf69268c2',
});

export const ZYLOS_SOURCE_FILES = Object.freeze([
  ['package.json', 'f10f86fa4dc2a90a61f7f5dd8fe0bacd58e047a908c52d9f663d7b45d62a534e'],
  ['cli/zylos.js', 'aead3893b809d8860140cd831194067c6151075f38c3a74cd18eba70cd9552ce'],
  ['cli/lib/runtime/base.js', '04a3a070d8a8750d375d750fa73b291800671416e2e680099945cf78ac7e9e85'],
  ['cli/lib/runtime/codex.js', 'b51e00cbbf3fc805b07103ab1c9a4147ff265da72ffa3bec55a43e1df882f219'],
  ['cli/lib/runtime/codex-context-monitor.js', 'b250bf10ede0aa41c378d9018dab8be81c16b1f9e25e60f050d81398e7de101c'],
  ['skills/comm-bridge/scripts/c4-receive.js', '66a94d5fdf1a65e702357eca3afd29be0037ee168679be8a04f503a7fb83204c'],
  ['skills/comm-bridge/scripts/c4-dispatcher.js', '79181aab729f70a841a244cb2883e2863568472ed2a6d86940c98333e2ebdc56'],
  ['skills/comm-bridge/scripts/c4-db.js', 'a524f42479fc13c7c880434736b709da36b3e8ff0d5f9ee0838d78e7bb50f159'],
  ['skills/comm-bridge/scripts/c4-config.js', '4ba1bff6db41eab4cc10cc109d25cf6b331c920460e640e7232a4d89e4b1f37e'],
  ['skills/comm-bridge/scripts/c4-control.js', '185629286e0bfce17e82d2a1ff3433982abfe5ba82a5d77c2eb339216636bbde'],
  ['skills/comm-bridge/scripts/c4-send.js', '8cac7842ff062beb643b7fcfab3737bd320677db0f3ffb7bd2cf8b7c44980585'],
  ['skills/comm-bridge/init-db.sql', '54faef85854a67d9ed04bf932f0383f30ba8feb467e597c7d1bbf82ead3b1f8e'],
].map(([relativePath, sha256]) => Object.freeze({ relativePath, sha256 })));
