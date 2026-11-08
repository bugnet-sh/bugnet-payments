import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { sendJson } from "../http/server.ts";

// The brand's fonts, cut and licensed as in bugnet-website/packages/brand/fonts
export const CHECKOUT_FONTS: readonly string[] = [
    "manrope-400.woff2",
    "manrope-600.woff2",
    "lexend-deca-200.woff2",
    "obel-mono-400.woff2",
];

// Exact request paths only, so no part of the URL ever reaches the file system
const FONT_FILES = new Map(CHECKOUT_FONTS.map((name) => [`/fonts/${name}`, name]));

// The fonts sit in fonts/ beside the checkout bundle, so dist/fonts in a build
export async function sendFont(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    checkoutJsPath: string,
): Promise<void> {
    const name = FONT_FILES.get(path);
    if (name === undefined || (req.method !== "GET" && req.method !== "HEAD")) {
        sendJson(res, 404, { error: "not_found" });
        return;
    }
    const body = await readFile(join(dirname(checkoutJsPath), "fonts", name));
    res.writeHead(200, {
        "Content-Type": "font/woff2",
        "Content-Length": String(body.length),
        "Cache-Control": "public, max-age=31536000, immutable",
    });
    res.end(req.method === "HEAD" ? undefined : body);
}
