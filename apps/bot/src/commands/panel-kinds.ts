/**
 * 常設パネル種別の**唯一の定義**。
 *
 * かつて「実装の `PANEL_KINDS`」「`/パネル設置` の選択肢」「`/管理 → パネル` の選択肢」の
 * 3箇所へ同じ表を手書きしていて、実際にドリフトしていた——`confession`（トートの耳）は
 * `/パネル設置` から選べず、`shop_admin`（冥界商館 管理）は**どの導線からも設置できない**のに
 * 更新処理だけ生きていた。
 *
 * ここは**データだけ**を持ち、パネル本文の組み立ては `bank-panel.ts` が担う。
 * 分けてあるのは、`/管理` が描画側を静的 import すると循環参照になるため。
 * `bank-panel.ts` 側には全 key を網羅する型検査が入っているので、
 * **この表に1行足せば、設置・撤去・描画の3経路すべてに反映される**。
 */
export interface PanelKindMeta {
  key: string;
  label: string;
  /** 新規設置できるか。`false` は廃止済みで、既設分の撤去だけできる */
  installable: boolean;
  /** 設置時に「部署」の指定が要る */
  needsDepartment?: boolean;
}

export const PANEL_KINDS = [
  { key: "casino", label: "マモンの賭場", installable: true },
  { key: "bank", label: "冥獄銀行", installable: true },
  { key: "entry", label: "入城申請", installable: true },
  // 入城案内パネルへ統合済み。新規設置はできないが、既設分の撤去のために種別は残す
  { key: "entry_flex", label: "時間外希望受付", installable: false },
  { key: "rank", label: "ランク確認", installable: true },
  { key: "shop", label: "公式ショップ", installable: true },
  { key: "shop_admin", label: "冥界商館 管理", installable: true },
  { key: "takutate", label: "卓建て", installable: true },
  { key: "ticket_return", label: "出戻り申請", installable: true },
  { key: "ticket_consult", label: "個別相談", installable: true },
  { key: "confession", label: "トートの耳", installable: true },
  { key: "room_normal", label: "宿", installable: true },
  { key: "room_mitsugetsu", label: "蜜月", installable: true },
  { key: "room_oborozuki", label: "朧月", installable: true },
  { key: "room_game", label: "ゲーム部屋", installable: true },
  { key: "dept", label: "部署運用", installable: true, needsDepartment: true },
] as const satisfies readonly PanelKindMeta[];

export type PanelKind = (typeof PANEL_KINDS)[number]["key"];

const BY_KEY = new Map<string, PanelKindMeta>(PANEL_KINDS.map((d) => [d.key, d]));

export function panelKindMeta(kind: string): PanelKindMeta | undefined {
  return BY_KEY.get(kind);
}

export function panelLabel(kind: string): string {
  return BY_KEY.get(kind)?.label ?? kind;
}

/** 新規設置できる種別。`/パネル設置` と `/管理 → パネル` の**両方**がこれを使う */
export function installablePanelChoices(): Array<{ name: string; value: string }> {
  return PANEL_KINDS.filter((d) => d.installable).map((d) => ({
    name: "needsDepartment" in d && d.needsDepartment ? `${d.label}（自分の残高と入れ替え）` : d.label,
    value: d.key,
  }));
}

/** 廃止済みで、撤去だけできる種別 */
export function retiredPanelChoices(): Array<{ name: string; value: string }> {
  return PANEL_KINDS.filter((d) => !d.installable).map((d) => ({ name: `${d.label}（廃止・撤去用）`, value: d.key }));
}

/** 撤去の選択肢は「設置できるもの＋廃止済み」 */
export function removablePanelChoices(): Array<{ name: string; value: string }> {
  return [...installablePanelChoices(), ...retiredPanelChoices()];
}
