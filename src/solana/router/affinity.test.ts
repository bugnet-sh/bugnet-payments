import { describe, expect, it } from "vitest";
import { CursorBook } from "./affinity.ts";

function page(...signatures: string[]): { signature: string }[] {
    return signatures.map((signature) => ({ signature }));
}

describe("CursorBook", () => {
    it("a page remembers its last entry, its endpoint and the entry before it", () => {
        const book = new CursorBook();
        book.remember("A", page("s1", "s2", "s3"), null, "rpc2");
        expect(book.entryOf("A", "s3")).toEqual({ endpoint: "rpc2", predecessor: "s2" });
    });

    it("a one-entry page takes the request's before as predecessor", () => {
        const book = new CursorBook();
        book.remember("A", page("s4"), "s3", "rpc1");
        expect(book.entryOf("A", "s4")).toEqual({ endpoint: "rpc1", predecessor: "s3" });
        book.remember("A", page("t1"), null, "rpc1");
        expect(book.entryOf("A", "t1")).toEqual({ endpoint: "rpc1", predecessor: null });
    });

    it("one signature can end pages of two addresses", () => {
        const book = new CursorBook();
        book.remember("HOT", page("H1", "PH", "S"), null, "rpc1");
        book.remember("COLD", page("PC", "S"), null, "rpc2");
        expect(book.entryOf("HOT", "S")).toEqual({ endpoint: "rpc1", predecessor: "PH" });
        expect(book.entryOf("COLD", "S")).toEqual({ endpoint: "rpc2", predecessor: "PC" });
        expect(book.entryOf("OTHER", "S")).toBeUndefined();
    });

    it("the book keeps 4096 cursors", () => {
        const book = new CursorBook();
        for (let i = 0; i <= 4_096; i++) book.remember("A", page(`s${i}`), null, "rpc1");
        expect(book.entryOf("A", "s0")).toBeUndefined();
        expect(book.entryOf("A", "s1")).toEqual({ endpoint: "rpc1", predecessor: null });
        expect(book.entryOf("A", "s4096")).toEqual({ endpoint: "rpc1", predecessor: null });
    });

    it("only the last signature is remembered", () => {
        const book = new CursorBook();
        book.remember("A", page("s1", "s2", "s3"), null, "rpc1");
        expect(book.entryOf("A", "s1")).toBeUndefined();
        expect(book.entryOf("A", "s2")).toBeUndefined();
    });

    it("an empty page remembers nothing", () => {
        const book = new CursorBook(2);
        book.remember("A", page("s1"), null, "rpc1");
        book.remember("A", page(), "s1", "rpc2");
        book.remember("B", page(), null, "rpc2");
        expect(book.entryOf("A", "s1")).toEqual({ endpoint: "rpc1", predecessor: null });
    });

    it("a cursor looked up is kept over older ones", () => {
        const book = new CursorBook(2);
        book.remember("A", page("s1"), null, "rpc1");
        book.remember("A", page("s2"), null, "rpc1");
        book.entryOf("A", "s1");
        book.remember("A", page("s3"), null, "rpc1");
        expect(book.entryOf("A", "s1")).toBeDefined();
        expect(book.entryOf("A", "s2")).toBeUndefined();
    });

    it("the same cursor seen again keeps its newest endpoint", () => {
        const book = new CursorBook();
        book.remember("A", page("s1", "s2"), null, "rpc1");
        book.remember("A", page("s2"), "s1", "rpc3");
        expect(book.entryOf("A", "s2")).toEqual({ endpoint: "rpc3", predecessor: "s1" });
    });

    it("an entry handed out cannot change the book", () => {
        const book = new CursorBook();
        book.remember("A", page("s1", "s2"), null, "rpc1");
        const entry = book.entryOf("A", "s2")!;
        entry.endpoint = "rpc9";
        expect(book.entryOf("A", "s2")).toEqual({ endpoint: "rpc1", predecessor: "s1" });
    });
});
