import {
    SolanaSignTransaction,
    type SolanaSignTransactionFeature,
} from "@solana/wallet-standard-features";
import { getWallets } from "@wallet-standard/app";
import {
    NO_ACCOUNT,
    NO_SIGNED,
    type PageStep,
    payWithWallet,
    reportError,
    type StatusDeps,
    UNREADABLE_CHALLENGE,
    WalletError,
    type WalletPort,
    walletError,
} from "./flow.ts";
import {
    fetchStatus,
    keepPolling,
    parseStatus,
    pollDelay,
    showWalletOptions,
    type StatusView,
    timeLeft,
    walletNote,
} from "./live.ts";
import {
    depositLine,
    errorStep,
    type MessageContext,
    PAGE_TEXT,
    pageStep,
    STATE_LABELS,
    walletMessage,
} from "./messages.ts";

type Wallet = ReturnType<ReturnType<typeof getWallets>["get"]>[number];
type WalletAccount = Wallet["accounts"][number];
type SignFeature = SolanaSignTransactionFeature[typeof SolanaSignTransaction];

interface ConnectFeature {
    connect(): Promise<{ accounts: readonly WalletAccount[] }>;
}

interface Page {
    root: HTMLElement;
    message: HTMLElement | null;
    depositMessage: HTMLElement | null;
    walletNote: HTMLElement | null;
    stateLabel: HTMLElement;
    status: StatusDeps;
    ctx: MessageContext;
}

const STANDARD_CONNECT = "standard:connect";
const MAINNET = "solana:mainnet";

function usable(w: Wallet): boolean {
    return (
        w.chains.includes(MAINNET) &&
        STANDARD_CONNECT in w.features &&
        SolanaSignTransaction in w.features
    );
}

// Shows W2 and W3 as the wallet asks, and remembers the stage for the error report
function portFor(w: Wallet, onStage: (stage: "connect" | "sign") => void): WalletPort {
    const connector = w.features[STANDARD_CONNECT] as ConnectFeature;
    const signer = w.features[SolanaSignTransaction] as SignFeature;
    let account: WalletAccount | undefined;
    return {
        async connect() {
            onStage("connect");
            const { accounts } = await connector.connect().catch((e: unknown) => {
                throw walletError(w.name, e);
            });
            account = accounts.find((a) => a.chains.includes(MAINNET)) ?? accounts[0];
            if (account === undefined) throw new Error(NO_ACCOUNT);
            return account;
        },
        async signTransaction(i) {
            if (account === undefined) throw new Error(NO_ACCOUNT);
            onStage("sign");
            // The wallet expects its own account object back, not the plain address
            const signed = await signer.signTransaction({ ...i, account }).catch((e: unknown) => {
                throw walletError(w.name, e);
            });
            return [...signed];
        },
    };
}

function element<T extends HTMLElement>(root: HTMLElement, selector: string): T {
    const el = root.querySelector<T>(selector);
    if (el === null) throw new Error(`checkout page has no ${selector}`);
    return el;
}

function setLabel(p: Page, label: string, state: string): void {
    p.stateLabel.textContent = label;
    p.stateLabel.dataset.state = state;
}

function showStep(p: Page, step: PageStep): number | undefined {
    if (p.message !== null) p.message.textContent = step.message;
    if (step.state !== undefined) setLabel(p, STATE_LABELS[step.state], step.state);
    return step.payAfterMs;
}

async function balanceOf(
    p: Page,
    owner: string,
): Promise<{ usdcMicros: number; needMicros: number } | null> {
    try {
        const res = await p.status.fetch(
            `${p.status.orderUrl}/balance?owner=${encodeURIComponent(owner)}`,
            { headers: { Accept: "application/json" } },
        );
        if (res.status !== 200) return null;
        const body = (await res.json()) as { usdcMicros?: unknown; needMicros?: unknown };
        if (typeof body.usdcMicros !== "number" || typeof body.needMicros !== "number") return null;
        return { usdcMicros: body.usdcMicros, needMicros: body.needMicros };
    } catch {
        return null;
    }
}

function startPayment(p: Page): void {
    const list = element<HTMLUListElement>(p.root, "#wallets");
    const button = element<HTMLButtonElement>(p.root, "#pay-button");
    const wallets = getWallets();
    let chosen: Wallet | undefined;
    let busy = false;
    let payable = true;

    const refresh = () => {
        button.disabled = busy || !payable || chosen === undefined;
    };

    const offerPayAfter = (ms: number | undefined) => {
        payable = ms === 0;
        if (ms === undefined || ms === 0) return;
        setTimeout(() => {
            payable = true;
            refresh();
        }, ms);
    };

    const render = () => {
        const found = wallets.get().filter(usable);
        if (chosen === undefined || !found.includes(chosen)) chosen = found[0];
        list.replaceChildren(
            ...found.map((w) => {
                const input = document.createElement("input");
                input.type = "radio";
                input.name = "wallet";
                input.checked = w === chosen;
                input.addEventListener("change", () => {
                    chosen = w;
                    refresh();
                });
                const icon = document.createElement("img");
                icon.src = w.icon;
                icon.alt = "";
                const label = document.createElement("label");
                label.append(input, icon, w.name);
                const item = document.createElement("li");
                item.className = "wallet";
                item.append(label);
                return item;
            }),
        );
        if (found.length === 0) {
            const item = document.createElement("li");
            item.textContent = PAGE_TEXT.noWallet;
            list.append(item);
        }
        refresh();
    };

    const pay = async (wallet: Wallet) => {
        busy = true;
        refresh();
        const ctx = { ...p.ctx, wallet: wallet.name };
        let stage: "connect" | "sign" | "challenge" = "challenge";
        const port = portFor(wallet, (s) => {
            stage = s;
            if (p.message !== null) {
                p.message.textContent =
                    s === "connect"
                        ? PAGE_TEXT.connecting(wallet.name)
                        : PAGE_TEXT.signing(wallet.name);
            }
        });
        let step: PageStep;
        try {
            const r = await payWithWallet({
                ...p.status,
                wallet: port,
                balance: (owner) => balanceOf(p, owner),
            });
            if (typeof r === "object" && "short" in r) {
                void reportError(p.status, {
                    stage: "balance",
                    wallet: wallet.name,
                    code: null,
                    message: `short ${r.short.haveMicros} ${r.short.needMicros}`,
                });
            }
            step = pageStep(r, ctx);
        } catch (err) {
            if (err instanceof WalletError) {
                void reportError(p.status, {
                    stage,
                    wallet: wallet.name,
                    code: err.code ?? null,
                    message: err.message,
                });
                step = walletMessage(err, ctx);
            } else {
                const message = err instanceof Error ? err.message : "error";
                const reportStage =
                    err instanceof TypeError
                        ? "status"
                        : message === UNREADABLE_CHALLENGE
                          ? "challenge"
                          : message === NO_SIGNED
                            ? "sign"
                            : stage;
                void reportError(p.status, {
                    stage: reportStage,
                    wallet: wallet.name,
                    code: null,
                    message,
                });
                step = errorStep(err, ctx);
            }
        }
        offerPayAfter(showStep(p, step));
        busy = false;
        refresh();
    };

    button.addEventListener("click", () => {
        if (chosen !== undefined && !busy && payable) void pay(chosen);
    });
    wallets.on("register", render);
    wallets.on("unregister", render);
    render();
}

const TICK_MS = 1_000;
const FAILURES_BEFORE_NOTICE = 3;

// Polls the order's status, keeps the countdown, and updates every live part of the page
function follow(p: Page): void {
    const expiresAt = Date.parse(p.root.dataset.expiresAt ?? "");
    const settleGraceMs = Number(p.root.dataset.settleGraceMs ?? "60000");
    const timeEl = p.root.querySelector<HTMLElement>("#time-left");
    const untilEl = p.root.querySelector<HTMLElement>("#until");
    const qr = p.root.querySelector<HTMLImageElement>("#deposit img");
    let offset = Date.parse(p.root.dataset.now ?? "") - Date.now();
    if (Number.isNaN(offset)) offset = 0;
    let remaining: number | null = null;
    if (untilEl !== null) untilEl.textContent = `until ${p.ctx.deadline}`;

    const tick = () => {
        if (timeEl !== null) timeEl.textContent = timeLeft(expiresAt, Date.now() + offset);
    };
    tick();
    const timer = setInterval(tick, TICK_MS);

    const apply = (v: StatusView) => {
        offset = v.serverNow - Date.now();
        const line = depositLine(v, p.ctx);
        setLabel(p, line.label, v.state);
        if (p.depositMessage !== null && (v.deposit !== null || v.state !== "unpaid")) {
            p.depositMessage.textContent = [line.message, ...line.extra].join(" ");
        }
        if (qr !== null && v.deposit !== null && v.deposit.remainingMicros !== remaining) {
            remaining = v.deposit.remainingMicros;
            qr.src = `/o/${p.ctx.orderId}/qr.svg?r=${remaining}`;
        }
        const options = showWalletOptions(v);
        for (const id of ["#wallet", "#phone"]) {
            const section = p.root.querySelector<HTMLElement>(id);
            if (section !== null) section.hidden = !options;
        }
        if (p.walletNote !== null) {
            const note = walletNote(v, p.ctx);
            p.walletNote.hidden = note === null;
            p.walletNote.textContent = note ?? "";
        }
    };

    let failures = 0;
    const poll = async () => {
        let retryAfterSeconds: number | undefined;
        let view: StatusView | null = null;
        try {
            const res = await fetchStatus(p.status);
            if (res.status === 429) {
                retryAfterSeconds = Number(res.headers.get("Retry-After") ?? "10") || 10;
                if (p.depositMessage !== null) {
                    p.depositMessage.textContent = PAGE_TEXT.tooMany(retryAfterSeconds);
                }
            } else if (res.status === 200) {
                view = parseStatus(await res.json());
            }
        } catch {
            view = null;
        }
        if (view === null && retryAfterSeconds === undefined) {
            failures += 1;
            if (failures >= FAILURES_BEFORE_NOTICE && p.depositMessage !== null) {
                p.depositMessage.textContent = PAGE_TEXT.unreachable;
            }
        } else if (view !== null) {
            failures = 0;
            apply(view);
            if (!keepPolling(view, Date.now() + offset, settleGraceMs)) {
                clearInterval(timer);
                return;
            }
        }
        const visible = document.visibilityState === "visible";
        setTimeout(() => void poll(), pollDelay({ visible, failures, retryAfterSeconds }));
    };
    void poll();
}

const COPIED_FOR_MS = 1_500;

function offerCopy(button: HTMLButtonElement, failed: (button: HTMLButtonElement) => void): void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    button.addEventListener("click", () => {
        navigator.clipboard.writeText(button.dataset.copy ?? "").then(
            () => {
                button.dataset.copied = "";
                clearTimeout(timer);
                timer = setTimeout(() => delete button.dataset.copied, COPIED_FOR_MS);
            },
            () => failed(button),
        );
    });
}

function localTime(ms: number): string {
    return new Date(ms).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });
}

const root = document.getElementById("checkout");
if (root !== null) {
    const expiresAt = Date.parse(root.dataset.expiresAt ?? "");
    const p: Page = {
        root,
        message: root.querySelector<HTMLElement>("#message"),
        depositMessage: root.querySelector<HTMLElement>("#deposit-message"),
        walletNote: root.querySelector<HTMLElement>("#wallet-note"),
        stateLabel: element<HTMLElement>(root, "#state"),
        status: {
            fetch: (input, init) => fetch(input, init),
            orderUrl: `${location.origin}/o/${root.dataset.orderId}`,
        },
        ctx: {
            amountMicros: Number(root.dataset.amountMicros ?? "0"),
            deadline: Number.isNaN(expiresAt) ? "" : localTime(expiresAt),
            refundMinMicros: Number(root.dataset.refundMinMicros ?? "0"),
            orderId: root.dataset.orderId ?? "",
        },
    };
    for (const button of root.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
        offerCopy(button, (b) => {
            const line = b.closest("#deposit") !== null ? p.depositMessage : p.message;
            if (line !== null) line.textContent = PAGE_TEXT.copyFailed;
        });
    }
    if (root.dataset.state === "unpaid" && root.querySelector("#pay-button") !== null) {
        startPayment(p);
    }
    follow(p);
}
