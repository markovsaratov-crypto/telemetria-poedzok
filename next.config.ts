import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: { ignoreBuildErrors: true },
  reactStrictMode: false,
  experimental: {
    serverActions: { bodySizeLimit: "100mb" },
  },
};

export default nextConfig;
