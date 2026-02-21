import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeCircularity } from "./hodge.js";

describe("computeCircularity", () => {
    it("returns zeros for empty input", () => {
        const r = computeCircularity([], []);
        assert.equal(r.ratio[2], 0);
        assert.equal(r.ratio[3], 0);
        assert.equal(r.circularFlow[2], 0);
        assert.equal(r.circularFlow[5], 0);
    });

    it("returns zeros for nodes with no edges", () => {
        const r = computeCircularity([{ id: "A" }, { id: "B" }], []);
        assert.equal(r.ratio[2], 0);
        assert.equal(r.circularFlow[2], 0);
    });

    it("returns zero for pure gradient (A->B)", () => {
        const r = computeCircularity(
            [{ id: "A" }, { id: "B" }],
            [{ source: "A", target: "B", amount: 100 }]
        );
        assert.equal(r.ratio[2], 0);
        assert.equal(r.circularFlow[2], 0);
    });

    it("returns 1.0 for a pure cycle (A->B->C->A equal flows)", () => {
        const nodes = [{ id: "A" }, { id: "B" }, { id: "C" }];
        const edges = [
            { source: "A", target: "B", amount: 10 },
            { source: "B", target: "C", amount: 10 },
            { source: "C", target: "A", amount: 10 },
        ];
        const r = computeCircularity(nodes, edges);
        assert.equal(r.ratio[2], 1.0);
        assert.equal(r.ratio[3], 1.0);
        assert.equal(r.circularFlow[2], 30);
        assert.equal(r.circularFlow[3], 30);
    });

    it("peels bottleneck correctly (A->B=100, B->C=50, C->A=10)", () => {
        const nodes = [{ id: "A" }, { id: "B" }, { id: "C" }];
        const edges = [
            { source: "A", target: "B", amount: 100 },
            { source: "B", target: "C", amount: 50 },
            { source: "C", target: "A", amount: 10 },
        ];
        const r = computeCircularity(nodes, edges);
        // Cycle A->B->C->A bottleneck=10, peeled 10*3=30, total=160
        assertClose(r.ratio[2], 30 / 160);
        assertClose(r.ratio[3], 30 / 160);
        assertClose(r.circularFlow[2], 30);
        assertClose(r.circularFlow[3], 30);
    });

    it("handles reciprocal flow (A->B=100, B->A=50)", () => {
        const nodes = [{ id: "A" }, { id: "B" }];
        const edges = [
            { source: "A", target: "B", amount: 100 },
            { source: "B", target: "A", amount: 50 },
        ];
        const r = computeCircularity(nodes, edges);
        // Cycle A->B->A bottleneck=50, peeled 50*2=100, total=150
        assertClose(r.ratio[2], 100 / 150);
        assertClose(r.circularFlow[2], 100);
        // 2-node cycle: excluded from >=3
        assert.equal(r.ratio[3], 0);
        assert.equal(r.circularFlow[3], 0);
    });

    it("separates 2-node and 3-node cycles", () => {
        const nodes = [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }];
        const edges = [
            // Reciprocal A<->B
            { source: "A", target: "B", amount: 100 },
            { source: "B", target: "A", amount: 50 },
            // 3-cycle B->C->D->B
            { source: "B", target: "C", amount: 30 },
            { source: "C", target: "D", amount: 20 },
            { source: "D", target: "B", amount: 20 },
        ];
        const r = computeCircularity(nodes, edges);
        // 2-cycle: bottleneck 50, flow 100
        // 3-cycle: bottleneck 20, flow 60
        // total flow = 100+50+30+20+20 = 220
        assertClose(r.circularFlow[2], 160); // 100 + 60
        assertClose(r.circularFlow[3], 60);  // only the 3-cycle
        assert.equal(r.circularFlow[4], 0);
        assert.equal(r.circularFlow[5], 0);
    });

    it("all ratios are between 0 and 1", () => {
        const nodes = [{ id: "A" }, { id: "B" }, { id: "C" }];
        const edges = [
            { source: "A", target: "B", amount: 77 },
            { source: "B", target: "C", amount: 33 },
            { source: "C", target: "A", amount: 12 },
            { source: "B", target: "A", amount: 5 },
        ];
        const r = computeCircularity(nodes, edges);
        for (const k of [2, 3, 4, 5]) {
            assert.ok(r.ratio[k] >= 0, `ratio[${k}] >= 0`);
            assert.ok(r.ratio[k] <= 1, `ratio[${k}] <= 1`);
        }
    });

    it("ratios are monotonically decreasing with cycle size", () => {
        const nodes = [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }];
        const edges = [
            { source: "A", target: "B", amount: 50 },
            { source: "B", target: "A", amount: 30 },
            { source: "B", target: "C", amount: 20 },
            { source: "C", target: "D", amount: 15 },
            { source: "D", target: "B", amount: 15 },
        ];
        const r = computeCircularity(nodes, edges);
        assert.ok(r.ratio[2] >= r.ratio[3]);
        assert.ok(r.ratio[3] >= r.ratio[4]);
        assert.ok(r.ratio[4] >= r.ratio[5]);
    });
});

function assertClose(actual, expected, tolerance = 1e-9) {
    assert.ok(
        Math.abs(actual - expected) < tolerance,
        `expected ${expected}, got ${actual}`
    );
}
