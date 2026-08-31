import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // v2.10.4 (TRUST-1): типы чисты (tsc --noEmit = 0) — блокировщик маски снят.
  // История: флаг ставился в v2.9.x как временный workaround серии Edge-bundle
  // build-failures (v2.9.8–v2.9.10, crypto в Edge); P0-фикс db.ts закрыл причину.
  typescript: { ignoreBuildErrors: false },
  reactStrictMode: false,
  experimental: {
    serverActions: { bodySizeLimit: "100mb" },
  },
};

export default nextConfig;
