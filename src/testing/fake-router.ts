import { createServer, type ServerHttp2Session } from "node:http2";
import type { AddressInfo } from "node:net";
import type { ServiceImpl } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { PaymentsService } from "../gen/bugnet/router/v1/payments_pb.ts";

export interface FakeRouter {
    url: string;
    headers: Headers[];
    close(): Promise<void>;
}

export async function startFakeRouter(
    impl: Partial<ServiceImpl<typeof PaymentsService>>,
): Promise<FakeRouter> {
    const headers: Headers[] = [];
    const handler = connectNodeAdapter({
        routes: (router) => router.service(PaymentsService, impl),
        interceptors: [
            (next) => (req) => {
                headers.push(new Headers(req.header));
                return next(req);
            },
        ],
    });
    const server = createServer(handler);
    const sessions = new Set<ServerHttp2Session>();
    server.on("session", (s: ServerHttp2Session) => {
        sessions.add(s);
        s.once("close", () => sessions.delete(s));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        headers,
        close: () =>
            new Promise<void>((resolve) => {
                server.close(() => resolve());
                for (const s of sessions) s.destroy();
            }),
    };
}
