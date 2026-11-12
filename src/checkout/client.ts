import {
    SolanaSignTransaction,
    type SolanaSignTransactionFeature,
} from "@solana/wallet-standard-features";
import { getWallets } from "@wallet-standard/app";
import {
    errorStage,
    fetchStatus,
    NO_ACCOUNT,
    type PageStep,
    payWithWallet,
    readBalance,
    reportError,
    shortReport,
    type StatusDeps,
    WalletError,
    type WalletPort,
    walletError,
} from "./flow.ts";
import {
    arrangement,
    keepPolling,
    walletNoteShown,
    needsReload,
    parseStatus,
    pollDelay,
    showDepositAsk,
    showDepositQr,
    showWalletOptions,
    statusKey,
    type StatusView,
    timeLeft,
    walletChoice,
    type WalletWatch,
    walletNote,
    watchWallet,
} from "./live.ts";
import {
    depositAsk,
    depositLine,
    errorStep,
    type MessageContext,
    PAGE_TEXT,
    pageStep,
    STATE_LABELS,
    stateStep,
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
    copyMessage: HTMLElement | null;
    // W35 as the last status answer had it, shown only beside a Pay button
    noteText: string;
    // While the order takes money, and how many usable browser wallets the page found
    takesMoney: boolean;
    walletsFound: number;
}

const STANDARD_CONNECT = "standard:connect";
const MAINNET = "solana:mainnet";

// A phone cannot scan its own screen and rarely has a browser wallet, so it gets the app links;
// the page's CSS hides the codes on the same screens
const PHONE = "(hover: none) and (pointer: coarse) and (max-width: 720px)";

function arrange(p: Page): void {
    const ask = p.root.querySelector<HTMLElement>("#deposit-ask");
    const a = arrangement({
        takesMoney: p.takesMoney,
        walletsFound: p.walletsFound,
        address: ask !== null && !ask.hidden,
        phone: window.matchMedia(PHONE).matches,
    });
    const show = (selector: string, shown: boolean) => {
        const el = p.root.querySelector<HTMLElement>(selector);
        if (el !== null) el.hidden = !shown;
    };
    show("#wallet", a.wallet);
    show("#phone", a.phone);
    show("#phone .mobile-links", a.phoneLinks);
    show("#phone figure", a.phoneQr);
    show("#or", a.or);
    // A live region, so it stays in the page and only its text comes and goes
    if (p.walletNote !== null) {
        const shown = walletNoteShown(a, p.walletsFound, p.noteText);
        const text = shown ? p.noteText : "";
        if (p.walletNote.textContent !== text) p.walletNote.textContent = text;
    }
}

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

// The wallet section's side of the poller: each status answer it is handed
interface WalletSection {
    seen(v: StatusView): void;
}

function startPayment(p: Page): WalletSection {
    const list = element<HTMLUListElement>(p.root, "#wallets");
    const button = element<HTMLButtonElement>(p.root, "#pay-button");
    const wallets = getWallets();
    let chosen: Wallet | undefined;
    let busy = false;
    let payable = true;
    // Set after W16 or W17, until the order shows whether the payment landed
    let watch: WalletWatch | null = null;

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

    const label = () => {
        const text = walletChoice([], chosen?.name).label;
        if (chosen === undefined) {
            button.textContent = text;
            return;
        }
        const icon = document.createElement("img");
        icon.src = chosen.icon;
        icon.alt = "";
        button.replaceChildren(icon, text);
    };

    const render = () => {
        const found = wallets.get().filter(usable);
        if (chosen === undefined || !found.includes(chosen)) chosen = found[0];
        list.replaceChildren(
            ...(found.length > 1 ? found : []).map((w) => {
                const input = document.createElement("input");
                input.type = "radio";
                input.name = "wallet";
                input.checked = w === chosen;
                input.addEventListener("change", () => {
                    chosen = w;
                    label();
                    refresh();
                });
                const icon = document.createElement("img");
                icon.src = w.icon;
                icon.alt = "";
                const choice = document.createElement("label");
                choice.append(input, icon, w.name);
                const item = document.createElement("li");
                item.append(choice);
                return item;
            }),
        );
        if (found.length === 0) {
            const item = document.createElement("li");
            item.className = "none";
            item.textContent = PAGE_TEXT.noWallet;
            list.append(item);
        }
        const choice = walletChoice(
            found.map((w) => w.name),
            chosen?.name,
        );
        list.hidden = !choice.list;
        button.hidden = !choice.button;
        label();
        p.walletsFound = found.length;
        arrange(p);
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
                balance: (owner) => readBalance(p.status, owner),
            });
            if (typeof r === "object" && "short" in r) {
                void reportError(p.status, shortReport(wallet.name, r.short));
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
                void reportError(p.status, {
                    stage: errorStage(err, stage),
                    wallet: wallet.name,
                    code: null,
                    message: err instanceof Error ? err.message : "error",
                });
                step = errorStep(err, ctx);
            }
        }
        watch =
            step.watch === undefined
                ? null
                : { unpaidForMs: step.watch.unpaidForMs ?? 0, unpaidSince: null };
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
    return {
        seen(v) {
            if (watch === null || busy) return;
            const next = watchWallet(watch, v.state, Date.now());
            if (next !== "unpaid") {
                watch = next;
                return;
            }
            watch = null;
            offerPayAfter(showStep(p, stateStep("unpaid", p.ctx)));
            refresh();
        },
    };
}

const TICK_MS = 1_000;
const FAILURES_BEFORE_NOTICE = 3;

const RELOADED_KEY = "bugnet-reloaded";
const RELOAD_GUARD_MS = 30_000;

// At most one reload in RELOAD_GUARD_MS per order, so a page can never reload in a loop
function reloadOnce(orderId: string): void {
    try {
        const key = `${RELOADED_KEY}:${orderId}`;
        const last = Number(sessionStorage.getItem(key) ?? "0");
        if (Date.now() - last < RELOAD_GUARD_MS) return;
        sessionStorage.setItem(key, String(Date.now()));
    } catch {
        // Without storage the page reloads anyway: the new page is drawn for unpaid
    }
    location.reload();
}

// Polls the order's status, keeps the countdown, and updates every live part of the page
function follow(p: Page, wallet: WalletSection | null): void {
    const expiresAt = Date.parse(p.root.dataset.expiresAt ?? "");
    const settleGraceMs = Number(p.root.dataset.settleGraceMs ?? "60000");
    const timeEl = p.root.querySelector<HTMLElement>("#time-left");
    const qr = p.root.querySelector<HTMLImageElement>("#deposit img");
    const askEls = {
        amount: p.root.querySelector<HTMLElement>("#deposit-amount"),
        copy: p.root.querySelector<HTMLButtonElement>("#deposit-amount-copy"),
        exchange: p.root.querySelector<HTMLElement>("#exchange-note"),
    };
    // M20 on a page without a deposit, put back once a status error line is no longer true
    const firstLine = p.depositMessage?.textContent ?? "";
    let offset = Date.parse(p.root.dataset.now ?? "") - Date.now();
    if (Number.isNaN(offset)) offset = 0;
    // What the server-drawn code asks for, so the first poll loads it again only if that changed
    const drawn = Number(qr?.dataset.remaining ?? Number.NaN);
    let remaining: number | null = Number.isNaN(drawn) ? null : drawn;
    let lastKey: string | null = null;
    let changedAt = Date.now();

    const tick = () => {
        if (timeEl !== null) timeEl.textContent = timeLeft(expiresAt, Date.now() + offset);
    };
    tick();
    const timer = setInterval(tick, TICK_MS);

    const apply = (v: StatusView) => {
        if (needsReload(p.root.dataset.state, v)) {
            reloadOnce(p.ctx.orderId);
            return;
        }
        offset = v.serverNow - Date.now();
        const key = statusKey(v);
        if (key !== lastKey) {
            lastKey = key;
            changedAt = Date.now();
        }
        const line = depositLine(v, p.ctx);
        setLabel(p, line.label, v.state);
        if (p.depositMessage !== null) {
            p.depositMessage.textContent =
                v.deposit !== null || v.state !== "unpaid"
                    ? [line.message, ...line.extra].filter((t) => t !== "").join(" ")
                    : firstLine;
        }
        // The QR asks for money only while the order lacks some
        const d = v.deposit;
        if (d !== null && v.state === "unpaid") {
            const ask = depositAsk(p.ctx.amountMicros, d);
            if (askEls.amount !== null) askEls.amount.textContent = `${ask.plain} USDC`;
            if (askEls.copy !== null) askEls.copy.dataset.copy = ask.plain;
            if (askEls.exchange !== null) askEls.exchange.textContent = ask.exchange;
            if (qr !== null) qr.alt = ask.alt;
        }
        const askEl = p.root.querySelector<HTMLElement>("#deposit-ask");
        if (askEl !== null) askEl.hidden = !showDepositAsk(v);
        // Wallet lines offer the address only while the page shows it (M3)
        p.ctx.hasAddress = askEl !== null && !askEl.hidden;
        // A countdown on an order that no longer takes money says nothing true
        const timeRow = timeEl?.closest<HTMLElement>(".time") ?? null;
        if (timeRow !== null) timeRow.hidden = !showWalletOptions(v);
        const qrShown = showDepositQr(v);
        const figure = qr?.closest("figure") ?? null;
        if (figure !== null) figure.hidden = !qrShown;
        if (qr !== null && d !== null && qrShown && d.remainingMicros !== remaining) {
            remaining = d.remainingMicros;
            qr.src = `/o/${p.ctx.orderId}/qr.svg?r=${remaining}`;
        }
        p.noteText = walletNote(v, p.ctx) ?? "";
        p.takesMoney = showWalletOptions(v);
        arrange(p);
        // After arrange, so a line W18 writes lands in a shown wallet part
        wallet?.seen(v);
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
            if (!keepPolling(view, Date.now() + offset, settleGraceMs, changedAt + offset)) {
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

function offerCopy(button: HTMLButtonElement, failed: () => void, copied: () => void): void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    button.addEventListener("click", () => {
        // Without the Clipboard API writeText throws before any promise, so it goes inside one
        Promise.resolve()
            .then(() => navigator.clipboard.writeText(button.dataset.copy ?? ""))
            .then(
                () => {
                    copied();
                    button.dataset.copied = "";
                    clearTimeout(timer);
                    timer = setTimeout(() => delete button.dataset.copied, COPIED_FOR_MS);
                },
                () => failed(),
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
        copyMessage: root.querySelector<HTMLElement>("#copy-message"),
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
            hasAddress: root.querySelector("#deposit-ask:not([hidden])") !== null,
        },
        noteText: "",
        takesMoney: root.dataset.state === "unpaid",
        walletsFound: 0,
    };
    for (const button of root.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
        // W34 has its own line, so it never replaces what happened to the order
        offerCopy(
            button,
            () => {
                if (p.copyMessage !== null) p.copyMessage.textContent = PAGE_TEXT.copyFailed;
            },
            () => {
                if (p.copyMessage !== null) p.copyMessage.textContent = "";
            },
        );
    }
    const wallet =
        root.dataset.state === "unpaid" && root.querySelector("#pay-button") !== null
            ? startPayment(p)
            : null;
    follow(p, wallet);
}
