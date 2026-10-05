import { NextRequest, NextResponse } from "next/server";
import { previewAaveAction } from "@/lib/mcp/aave";

/**
 * POST /api/preview-action
 *
 * Simulates an Aave action (supply/borrow/withdraw/repay) and returns
 * the predicted health factor change. Uses Aave's official MCP server
 * for accurate simulation — no guessing.
 *
 * Request: { address, chainId, action, asset, amount }
 * Response: { healthFactorBefore, healthFactorAfter, willLiquidate }
 */
export async function POST(req: NextRequest) {
  try {
    const { address, chainId, action, asset, amount } = await req.json();

    if (!address || !chainId || !action || !asset || !amount) {
      return NextResponse.json(
        { error: "Missing required fields: address, chainId, action, asset, amount" },
        { status: 400 },
      );
    }

    const validActions = ["supply", "borrow", "withdraw", "repay"];
    if (!validActions.includes(action)) {
      return NextResponse.json(
        { error: `Invalid action: ${action}. Must be one of: ${validActions.join(", ")}` },
        { status: 400 },
      );
    }

    const preview = await previewAaveAction(address, chainId, action, asset, String(amount));

    if (!preview) {
      return NextResponse.json(
        { error: "Health factor simulation unavailable — Aave MCP server did not respond." },
        { status: 502 },
      );
    }

    return NextResponse.json(preview);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message || "Preview failed" },
      { status: 500 },
    );
  }
}
