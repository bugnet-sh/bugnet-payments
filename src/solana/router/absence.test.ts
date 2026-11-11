import { describe, expect, it } from "vitest";
import { mergeStatuses, type Status, type StatusesAnswer } from "./absence.ts";
import { signatureStatus as S } from "./testing.ts";

function answer(slot: bigint, value: Status[]): StatusesAnswer {
    return { jsonrpc: "2.0", id: 1n, result: { context: { slot }, value } };
}

describe("mergeStatuses", () => {
    it("a status beats null", () => {
        const merged = mergeStatuses(
            answer(10n, [null, null]),
            answer(12n, [S(5n, "confirmed"), null]),
        );
        expect(merged).not.toBe("conflict");
        const { result } = merged as StatusesAnswer;
        expect(result.value).toEqual([S(5n, "confirmed"), null]);
        expect(result.context.slot).toBe(10n);
    });

    it("the more settled status wins", () => {
        const processed = answer(10n, [S(5n, "processed")]);
        const finalized = answer(10n, [S(5n, "finalized")]);
        for (const [x, y] of [
            [processed, finalized],
            [finalized, processed],
        ] as const) {
            const merged = mergeStatuses(x, y) as StatusesAnswer;
            expect(merged.result.value[0]?.confirmationStatus).toBe("finalized");
        }
    });

    it("different errors conflict", () => {
        const failed = { InstructionError: [2n, { Custom: 1n }] };
        expect(
            mergeStatuses(
                answer(10n, [S(5n, "confirmed")]),
                answer(10n, [S(5n, "confirmed", failed)]),
            ),
        ).toBe("conflict");
    });

    it("different lengths conflict", () => {
        expect(mergeStatuses(answer(10n, [null]), answer(10n, [null, null]))).toBe("conflict");
    });
});
