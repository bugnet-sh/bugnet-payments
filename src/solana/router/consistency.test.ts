import { beforeEach, describe, expect, it } from "vitest";
import { ConsistencyBook, IdentityBook, type Verdict } from "./consistency.ts";

const HOUR = 3_600_000;
let ms = 0;
let book: ConsistencyBook;

function fresh(): ConsistencyBook {
    return new ConsistencyBook({ now: () => ms, clearAfterMs: HOUR });
}

beforeEach(() => {
    ms = 0;
    book = fresh();
});

describe("ConsistencyBook", () => {
    it("an endpoint is unknown until a run agrees", () => {
        expect(book.state("a")).toBe("unknown");
        book.checkRun("a", true, 0);
        expect(book.state("a")).toBe("yes");
        book.checkRun("b", false, 0);
        expect(book.state("b")).toBe("no");
    });

    it("a found signature read null later marks the endpoint", () => {
        book.found("a", "S");
        expect(book.nullFor("a", "S")).toBe(true);
        expect(book.state("a")).toBe("no");
        expect(book.nullFor("a", "T")).toBe(false);
        expect(book.nullFor("b", "S")).toBe(false);
        expect(book.state("b")).toBe("unknown");
    });

    it("a no clears only by a run started an hour after the mark", () => {
        book.found("a", "S");
        ms = 1_000;
        book.nullFor("a", "S");
        expect(book.state("a")).toBe("no");
        book.checkRun("a", true, 2_000);
        expect(book.state("a")).toBe("no");
        book.checkRun("a", true, 3_600_999);
        expect(book.state("a")).toBe("no");
        book.checkRun("a", true, 3_601_000);
        expect(book.state("a")).toBe("yes");
    });

    it("a disagreeing run marks a consistent endpoint", () => {
        book.checkRun("a", true, 0);
        book.checkRun("a", false, 5_000);
        expect(book.state("a")).toBe("no");
        book.checkRun("a", true, 5_000 + HOUR);
        expect(book.state("a")).toBe("yes");

        book.checkRun("b", true, 0);
        book.disagree("b", "slot_went_back");
        expect(book.state("b")).toBe("no");
    });

    it("a later mark starts the hour again", () => {
        book.found("a", "S");
        ms = 1_000;
        book.nullFor("a", "S");
        ms = 2_000_000;
        book.disagree("a", "slot_went_back");
        book.checkRun("a", true, 1_000 + HOUR);
        expect(book.state("a")).toBe("no");
        book.checkRun("a", true, 2_000_000 + HOUR);
        expect(book.state("a")).toBe("yes");
    });

    it("a loaded verdict holds across a restart", () => {
        ms = 1_200_000;
        book.load("a", { noAt: 0, reason: "found_then_missing", historyPassed: true });
        expect(book.state("a")).toBe("no");
        book.checkRun("a", true, 1_200_000);
        expect(book.state("a")).toBe("no");
        book.checkRun("a", true, 3_600_000);
        expect(book.state("a")).toBe("yes");
        expect(book.historyPassed("a")).toBe(true);
    });

    it("a loaded verdict never gives a vote back", () => {
        book.checkRun("a", true, 0);
        book.passHistory("a");
        book.load("a", { noAt: 0, reason: "check_disagreed", historyPassed: false });
        expect(book.state("a")).toBe("no");
        expect(book.historyPassed("a")).toBe(true);
        book.load("b", { noAt: null, reason: null, historyPassed: true });
        expect(book.state("b")).toBe("unknown");
        expect(book.historyPassed("b")).toBe(true);
    });

    it("changes are reported for saving", () => {
        const changes: [string, Verdict][] = [];
        book.onChange((endpoint, v) => changes.push([endpoint, v]));
        book.found("a", "S");
        ms = 1_000;
        book.nullFor("a", "S");
        expect(changes).toEqual([
            ["a", { noAt: 1000, reason: "found_then_missing", historyPassed: false }],
        ]);
        book.checkRun("a", true, 1_000 + HOUR);
        expect(changes.slice(1)).toEqual([
            ["a", { noAt: null, reason: null, historyPassed: false }],
        ]);
        book.passHistory("a");
        expect(changes.slice(2)).toEqual([
            ["a", { noAt: null, reason: null, historyPassed: true }],
        ]);
        book.checkRun("a", true, 2 * HOUR);
        book.passHistory("a");
        expect(changes).toHaveLength(3);
    });

    it("the book keeps 4096 found signatures per endpoint", () => {
        for (let i = 0; i < 4_097; i++) book.found("a", `S${i}`);
        expect(book.nullFor("a", "S0")).toBe(false);
        expect(book.nullFor("a", "S4096")).toBe(true);
    });
});

describe("IdentityBook", () => {
    it("two endpoints that report one identity share a node", () => {
        const ids = new IdentityBook();
        expect(ids.saw("rpc1", "N1")).toEqual([]);
        expect(ids.saw("rpc2", "N1")).toEqual(["rpc1"]);
        expect(ids.shares("rpc1", "rpc2")).toBe(true);
        expect(ids.shares("rpc2", "rpc1")).toBe(true);
        expect(ids.shares("rpc1", "rpc3")).toBe(false);
        expect(ids.saw("rpc2", "N1")).toEqual([]);

        for (let i = 0; i < 16; i++) ids.saw("rpc1", `M${i}`);
        expect(ids.saw("rpc3", "N1")).toEqual(["rpc2"]);
        expect(ids.saw("rpc4", "M0")).toEqual(["rpc1"]);
        expect(ids.shares("rpc1", "rpc2")).toBe(true);
    });
});
