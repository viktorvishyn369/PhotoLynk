// ─────────────────────────────────────────────────────────────────────────────
//  PINATA ACCOUNTS — solana-seeker (mobile, client-side mints)
// ─────────────────────────────────────────────────────────────────────────────
//
//  HOW TO ADD A NEW PINATA ACCOUNT:
//    1. Create the JWT in the Pinata dashboard (full pinning permissions).
//    2. Paste it as a new entry in the `accounts` array below.
//    3. Save and rebuild the seeker app (the JWT gets bundled in the APK/IPA).
//
//  ORDER MATTERS:
//    Accounts are tried top-to-bottom for uploads. When one returns a rate-
//    limit / quota / auth error, the next is automatically used mid-mint.
//
//  KEEP IN SYNC WITH SERVER:
//    The server-side equivalent lives at:
//      /nft-service/pinataAccounts.js
//    When a burn unpins files, the server iterates ITS list (not this one),
//    so for burn cleanup to work for files uploaded by the seeker, those
//    JWTs must also exist in the server's pinataAccounts.js.
//
//  ENV OVERRIDES (optional, build-time):
//    EXPO_PUBLIC_PINATA_JWT
//    EXPO_PUBLIC_PINATA_JWT_FALLBACK
//    EXPO_PUBLIC_PINATA_JWT_EXTRA
//    EXPO_PUBLIC_PINATA_JWT_EXTRA2
//    EXPO_PUBLIC_PINATA_JWT_LIST (comma-separated)
//
// ─────────────────────────────────────────────────────────────────────────────

export const accounts = [
  // ─── PRIMARY ───────────────────────────────────────────────────────────────
  {
    label: 'primary',
    jwt: '', // set via EXPO_PUBLIC_PINATA_JWT, or paste here
  },

  // ─── FALLBACK 1 (viktor.vishyn.963@gmail.com) ──────────────────────────────
  {
    label: 'fallback-vv963',
    jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySW5mb3JtYXRpb24iOnsiaWQiOiI1YmY5YWY4OS04YmY5LTRkYTMtYWU0ZS01YTUwZWRkYzUwMTAiLCJlbWFpbCI6InZpa3Rvci52aXNoeW4uOTYzQGdtYWlsLmNvbSIsImVtYWlsX3ZlcmlmaWVkIjp0cnVlLCJwaW5fcG9saWN5Ijp7InJlZ2lvbnMiOlt7ImRlc2lyZWRSZXBsaWNhdGlvbkNvdW50IjoxLCJpZCI6IkZSQTEifSx7ImRlc2lyZWRSZXBsaWNhdGlvbkNvdW50IjoxLCJpZCI6Ik5ZQzEifV0sInZlcnNpb24iOjF9LCJtZmFfZW5hYmxlZCI6ZmFsc2UsInN0YXR1cyI6IkFDVElWRSJ9LCJhdXRoZW50aWNhdGlvblR5cGUiOiJzY29wZWRLZXkiLCJzY29wZWRLZXlLZXkiOiJlN2ZlZWY2OGVhMzg5ZTkxOGZhMSIsInNjb3BlZEtleVNlY3JldCI6IjJjNjBjNDIzNDQ4NWU3NTgzNTczZGVjMjhiNzlhZTFjZTA1NzFmNzU0OGFlNDc0YmFiMDk3NjkyYWY0ODVhNGUiLCJleHAiOjE4MDgzMTU2MzF9.3vc_6PKHz_n37kTQXq6h1pii-FWn3ioSP2HZsvKCKNQ',
  },

  // ─── FALLBACK 2 (support@stealthlynk.io) ───────────────────────────────────
  {
    label: 'fallback-support',
    jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySW5mb3JtYXRpb24iOnsiaWQiOiI2NDRmMDAwNC03M2U5LTQ4NDQtOWQwMi0xOTk4NGQ5NDMxN2MiLCJlbWFpbCI6InN1cHBvcnRAc3RlYWx0aGx5bmsuaW8iLCJlbWFpbF92ZXJpZmllZCI6dHJ1ZSwicGluX3BvbGljeSI6eyJyZWdpb25zIjpbeyJkZXNpcmVkUmVwbGljYXRpb25Db3VudCI6MSwiaWQiOiJGUkExIn0seyJkZXNpcmVkUmVwbGljYXRpb25Db3VudCI6MSwiaWQiOiJOWUMxIn1dLCJ2ZXJzaW9uIjoxfSwibWZhX2VuYWJsZWQiOmZhbHNlLCJzdGF0dXMiOiJBQ1RJVkUifSwiYXV0aGVudGljYXRpb25UeXBlIjoic2NvcGVkS2V5Iiwic2NvcGVkS2V5S2V5IjoiNGI5NWVjM2MzOWRjZGYwNzE4OWMiLCJzY29wZWRLZXlTZWNyZXQiOiJjMGFmODEzNzE4NjZkOTQyNzZkODViOTUyNTdjZjE3YzFkY2I5MTFjYWE2ZWZlNDI1MThiNzIwN2ExN2U1NjllIiwiZXhwIjoxODA5MDE2MTk0fQ.YntaybzjqSZ_DUh3HbJjDI6SVcp9bVAOPxUZq-4abhM',
  },

  // ─── ADD NEW ACCOUNTS BELOW ────────────────────────────────────────────────
  // Just copy this template and paste your JWT:
  //
  // {
  //   label: 'my-new-account',
  //   jwt: 'eyJ...',
  // },
];

/**
 * Returns every configured Pinata JWT in priority order.
 * Merges env-var overrides (EXPO_PUBLIC_PINATA_JWT*, PINATA_JWT_LIST) with
 * the static `accounts` array above. De-duplicates by JWT value.
 */
export function getAllPinataJwts() {
  const seen = new Set();
  const out = [];
  const push = (label, jwt) => {
    const v = (jwt || '').trim();
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push({ label, jwt: v });
  };

  // 1. Env-var overrides (build-time).
  push('env:primary',   process.env.PINATA_JWT || process.env.EXPO_PUBLIC_PINATA_JWT);
  push('env:fallback',  process.env.PINATA_JWT_FALLBACK || process.env.EXPO_PUBLIC_PINATA_JWT_FALLBACK);
  push('env:extra',     process.env.PINATA_JWT_EXTRA || process.env.EXPO_PUBLIC_PINATA_JWT_EXTRA);
  push('env:extra2',    process.env.PINATA_JWT_EXTRA2 || process.env.EXPO_PUBLIC_PINATA_JWT_EXTRA2);
  // Comma/whitespace separated list.
  const listRaw = process.env.PINATA_JWT_LIST || process.env.EXPO_PUBLIC_PINATA_JWT_LIST || '';
  String(listRaw).split(/[\s,]+/).map(v => v.trim()).filter(Boolean).forEach((j, i) => push(`env:list${i + 1}`, j));

  // 2. Static `accounts` array (paste-and-go list).
  for (const a of accounts) {
    if (a && a.jwt) push(a.label || 'unnamed', a.jwt);
  }

  return out;
}
