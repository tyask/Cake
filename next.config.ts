import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the development badge clear of the mobile navigation during Cloud QA.
  devIndicators: process.env.CAKE_CLOUD_MODE === "memory" ? false : undefined,
  images: {
    remotePatterns: [{ protocol: "https", hostname: "lh3.googleusercontent.com" }],
  },
};

export default nextConfig;
