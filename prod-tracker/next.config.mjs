/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The store writes to a JSON file next to the app; nothing is bundled from it.
  experimental: {
    serverComponentsExternalPackages: [],
  },
};

export default nextConfig;
