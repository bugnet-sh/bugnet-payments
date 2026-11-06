import {
    SolanaSignTransaction,
    type SolanaSignTransactionFeature,
} from "@solana/wallet-standard-features";
import { getWallets } from "@wallet-standard/app";
import { describeResult, type PayFlowResult, payWithWallet, type WalletPort } from "./flow.ts";

type Wallet = ReturnType<ReturnType<typeof getWallets>["get"]>[number];
type WalletAccount = Wallet["accounts"][number];
type SignFeature = SolanaSignTransactionFeature[typeof SolanaSignTransaction];

interface ConnectFeature {
    connect(): Promise<{ accounts: readonly WalletAccount[] }>;
}

const STANDARD_CONNECT = "standard:connect";
const MAINNET = "solana:mainnet";

function usable(w: Wallet): boolean {
    return STANDARD_CONNECT in w.features && SolanaSignTransaction in w.features;
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

function start(root: HTMLElement): void {
    const list = element<HTMLUListElement>(root, "#wallets");
    const button = element<HTMLButtonElement>(root, "#pay-button");
    const message = element<HTMLElement>(root, "#message");
    const stateLabel = element<HTMLElement>(root, "#state");
    const orderUrl = `${location.origin}/o/${root.dataset.orderId}`;
    const wallets = getWallets();
    let chosen: Wallet | undefined;
    let busy = false;
    let done = false;

    const refresh = () => {
        button.disabled = busy || done || chosen === undefined;
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

    const show = (result: PayFlowResult) => {
        message.textContent = describeResult(result);
        if (result === "paid") {
            done = true;
            stateLabel.textContent = "Paid";
        }
    };

    const pay = async (wallet: Wallet) => {
        busy = true;
        refresh();
        message.textContent = "waiting for the wallet";
        try {
            show(
                await payWithWallet({
                    fetch: (input, init) => fetch(input, init),
                    wallet: portFor(wallet),
                    orderUrl,
                }),
            );
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            message.textContent = `the payment did not go through: ${reason}`;
        }
        busy = false;
        refresh();
    };

    button.addEventListener("click", () => {
        if (chosen !== undefined && !busy) void pay(chosen);
    });
    wallets.on("register", render);
    wallets.on("unregister", render);
    render();
}

const root = document.getElementById("checkout");
if (root !== null && root.dataset.state === "unpaid") start(root);
