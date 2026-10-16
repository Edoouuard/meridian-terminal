import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The planner reads its doctrine from this markdown file at runtime.
  outputFileTracingIncludes: {
    "/api/parse-intent": ["./src/lib/planner/STRATEGIST.md"],
  },
};

export default nextConfig;
