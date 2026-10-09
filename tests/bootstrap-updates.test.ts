import assert from "node:assert/strict";
import test from "node:test";
import { bootstrapScopeForTab, mergeBootstrapMetadata, type DashboardTab } from "../lib/bootstrap";
import { calculateSettlement } from "../lib/settlement";
import type { BootstrapData, BootstrapMetadata, TransactionRecord } from "../lib/types";

function fixture(): { current: BootstrapData; metadata: BootstrapMetadata } {
  const user = { id: "a", email: "a@example.test", name: "A", imageUrl: null };
  const members = [
    { ...user, weight: 1, role: "OWNER" as const },
    { id: "b", email: "b@example.test", name: "B", imageUrl: null, weight: 1, role: "MEMBER" as const },
  ];
  const workspace = { id: "workspace", name: "家計", type: "SHARED" as const, ownerUserId: user.id, memberCount: 2 };
  const transactions: TransactionRecord[] = [{
    id: "transaction", occurredAt: "2026-10-08T00:00:00.000Z", merchant: "スーパー", method: "現金",
    memo: "保存済み", type: "PAYMENT", amountYen: 1000, actorUserId: user.id, actorName: "A",
    expenseClass: "SHARED", splitWeights: { a: 1, b: 1 }, settledAt: null, externalId: "manual", source: "MANUAL",
  }];
  const current: BootstrapData = {
    user, workspaces: [workspace], pendingInvitations: [],
    selected: {
      workspace, members, transactions, rules: [], settlement: calculateSettlement(members, transactions),
      settlementHistory: [{ id: "history", payerName: "B", payeeName: "A", amountYen: 200, completedAt: "2026-10-07T00:00:00.000Z" }],
    },
  };
  const updatedWorkspace = { ...workspace, name: "更新された家計" };
  const metadata: BootstrapMetadata = {
    user: { ...user, name: "新しい名前" }, workspaces: [updatedWorkspace],
    pendingInvitations: [{ id: "invite", workspaceName: "別の家計", inviterName: "C", expiresAt: "2026-10-15T00:00:00.000Z" }],
    selected: {
      workspace: updatedWorkspace, members: members.map(member => ({ ...member, imageUrl: `${member.id}.png` })),
      rules: [{ id: "rule", merchantContains: "スーパー", expenseClass: "SHARED", sortOrder: 0, splitWeights: { a: 1, b: 1 }, enabled: true }],
    },
  };
  return { current, metadata };
}

test("同じ家計の取込・設定用データは更新し、取得済みの明細・清算情報と元データを保持する", () => {
  const { current, metadata } = fixture();
  const originalCurrent = structuredClone(current);
  const originalMetadata = structuredClone(metadata);
  const merged = mergeBootstrapMetadata(current, metadata);

  assert.ok(merged?.selected);
  assert.notStrictEqual(merged, current);
  assert.notStrictEqual(merged.selected, current.selected);
  assert.strictEqual(merged.user, metadata.user);
  assert.strictEqual(merged.workspaces, metadata.workspaces);
  assert.strictEqual(merged.pendingInvitations, metadata.pendingInvitations);
  assert.strictEqual(merged.selected.workspace, metadata.selected!.workspace);
  assert.strictEqual(merged.selected.members, metadata.selected!.members);
  assert.strictEqual(merged.selected.rules, metadata.selected!.rules);
  assert.strictEqual(merged.selected.transactions, current.selected!.transactions);
  assert.strictEqual(merged.selected.settlement, current.selected!.settlement);
  assert.strictEqual(merged.selected.settlementHistory, current.selected!.settlementHistory);
  assert.deepEqual(current, originalCurrent);
  assert.deepEqual(metadata, originalMetadata);
});

test("別の家計のデータには以前の明細を混ぜず、全データ取得が必要なことを返す", () => {
  const { current, metadata } = fixture();
  const previous = structuredClone(current);
  metadata.selected!.workspace = { ...metadata.selected!.workspace, id: "other-workspace" };

  assert.equal(mergeBootstrapMetadata(current, metadata), null);
  assert.deepEqual(current, previous);
});

test("初めて家計を選択したときは取込・設定用データだけで全データを組み立てない", () => {
  const { current, metadata } = fixture();
  const empty: BootstrapData = { ...current, selected: null };

  assert.equal(mergeBootstrapMetadata(empty, metadata), null);
  assert.equal(empty.selected, null);
});

test("選択先がなくなった場合は取得済みの明細も外し、最新の利用者・招待情報を反映する", () => {
  const { current, metadata } = fixture();
  const cleared: BootstrapMetadata = { ...metadata, selected: null, workspaces: [] };
  const merged = mergeBootstrapMetadata(current, cleared);

  assert.deepEqual(merged, cleared);
  assert.strictEqual(merged?.user, cleared.user);
  assert.strictEqual(merged?.pendingInvitations, cleared.pendingInvitations);
  assert.equal(merged?.selected, null);
  assert.equal(current.selected?.transactions.length, 1);
});

test("取込・設定だけを軽量取得にし、集計・明細・清算には全データを要求する", () => {
  for (const tab of ["import", "settings"] satisfies DashboardTab[]) {
    assert.equal(bootstrapScopeForTab(tab), "metadata");
  }
  for (const tab of ["home", "transactions", "settlement"] satisfies DashboardTab[]) {
    assert.equal(bootstrapScopeForTab(tab), "full");
  }
});
