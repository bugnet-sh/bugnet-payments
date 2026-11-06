import {
    SolanaSignTransaction,
    type SolanaSignTransactionFeature,
} from "@solana/wallet-standard-features";
import { getWallets } from "@wallet-standard/app";
import {
    type PageStep,
    pageStep,
    payWithWallet,
    STATE_LABELS,
    type StatusDeps,
    stateStep,
    type WalletPort,
    watchOrder,
} from "./flow.ts";

type Wallet = ReturnType<ReturnType<typeof getWallets>["get"]>[number];
type WalletAccount = Wallet["accounts"][number];
type SignFeature = SolanaSignTransactionFeature[typeof SolanaSignTransaction];

interface ConnectFeature {
    connect(): Promise<{ accounts: readonly WalletAccount[] }>;
}

interface View {
    message: HTMLElement;
    stateLabel: HTMLElement;
    status: StatusDeps;
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

function portFor(w: Wallet): WalletPort {
    const connector = w.features[STANDARD_CONNECT] as ConnectFeature;
    const signer = w.features[SolanaSignTransaction] as SignFeature;
    let account: WalletAccount | undefined;
    return {
        async connect() {
            const { accounts } = await connector.connect();
            account = accounts.find((a) => a.chains.includes(MAINNET)) ?? accounts[0];
            if (account === undefined) throw new Error("the wallet shared no account");
            return account;
        },
        async signTransaction(i) {
            if (account === undefined) throw new Error("the wallet is not connected");
            // The wallet expects its own account object back, not the plain address
            return [...(await signer.signTransaction({ ...i, account }))];
        },
    };
}

function element<T extends HTMLElement>(root: HTMLElement, selector: string): T {
    const el = root.querySelector<T>(selector);
    if (el === null) throw new Error(`checkout page has no ${selector}`);
    return el;
}

// Shows a step, follows the order's status when the step leaves it unknown, and answers payAfterMs
async function show(v: View, step: PageStep): Promise<number | undefined> {
    v.message.textContent = step.message;
    if (step.state !== undefined) v.stateLabel.textContent = STATE_LABELS[step.state];
    if (!step.watch) return step.payAfterMs;
    return show(v, stateStep(await watchOrder(v.status)));
}

function startPayment(root: HTMLElement, v: View): void {
    const list = element<HTMLUListElement>(root, "#wallets");
    const button = element<HTMLButtonElement>(root, "#pay-button");
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
                item.append(label);
                return item;
            }),
        );
        if (found.length === 0) {
            const item = document.createElement("li");
            item.textContent =
                "No Solana wallet found in this browser. " +
                "Install Phantom or Solflare, or open this page in their app.";
            list.append(item);
        }
        refresh();
    };

    const pay = async (wallet: Wallet) => {
        busy = true;
        refresh();
        v.message.textContent = "waiting for the wallet";
        let step: PageStep;
        try {
            step = pageStep(await payWithWallet({ ...v.status, wallet: portFor(wallet) }));
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            step = { message: `the payment did not go through: ${reason}`, payAfterMs: 0 };
        }
        offerPayAfter(await show(v, step));
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

async function followSettling(v: View): Promise<void> {
    v.message.textContent = "the payment is settling; checking status…";
    const state = await watchOrder(v.status);
    // Only the unpaid page carries the wallet list and the QR
    if (state === "unpaid") location.reload();
    else await show(v, stateStep(state));
}

const root = document.getElementById("checkout");
if (root !== null) {
    const v: View = {
        message: element<HTMLElement>(root, "#message"),
        stateLabel: element<HTMLElement>(root, "#state"),
        status: {
            fetch: (input, init) => fetch(input, init),
            orderUrl: `${location.origin}/o/${root.dataset.orderId}`,
        },
    };
    if (root.dataset.state === "unpaid") startPayment(root, v);
    else if (root.dataset.state === "settling") void followSettling(v);
}
