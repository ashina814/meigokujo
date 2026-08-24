import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/bootstrap.js";
import { Entry } from "../src/entry/service.js";
import { EventLog } from "../src/events/service.js";
import { Ledger } from "../src/ledger/service.js";
import { registerDefaultTxTypes } from "../src/ledger/registry.js";
import { Settings } from "../src/settings/service.js";
import { TcSocialObservations } from "../src/tc-social/service.js";
import { TITLE_SOURCES } from "../src/titles/v2-contract.js";
import { defineTitleRule } from "../src/titles/v2-evaluator.js";
import { computeInviteRootedSafe } from "../src/titles/v2-invite-rooted.js";
import { resolveTitleScope } from "../src/titles/v2-scope.js";
import { readTitleSource, TitleSourceCache } from "../src/titles/v2-sources.js";
import { TitleV2Store } from "../src/titles/v2-store.js";

registerDefaultTxTypes();

const DAY = 86_400;
const HOUR = 3_600;
const ENTRY = Math.floor(new Date("2026-08-01T12:00:00+09:00").getTime() / 1_000);
const START = ENTRY - 10 * DAY;
const END = ENTRY + 40 * DAY;

const RULE = defineTitleRule(
  {
    kind: "behavior",
    key: "v2.test.invite-rooted-safe",
    catalog: "test",
    name: "test invite rooted safe",
    emoji: "x",
    description: "source fixture",
    sources: ["invite_rooted_safe"] as const,
    triggers: ["invite_confirmed", "text_activity", "vc_activity"],
    lifecycle: "active",
    hidden: false,
    publicAnnounce: false,
    themeKey: "test-theme",
    groupKey: "test-group",
    collectionDomainKey: "test-domain",
    scope: { type: "global" },
  },
  { awardFactsVersion: 1, evaluate: () => ({ matched: false, earnedAt: null }) },
);

function setup(systemEpoch = START) {
  const db = openDb(":memory:");
  const tc = new TcSocialObservations(db);
  let clock = systemEpoch;
  const store = new TitleV2Store(db, () => clock);
  store.applyCatalog({ catalogKey: "test", actor: "setup" });
  clock = END;

  const invite = (inviter: string, invitee: string, creditedAt = ENTRY + 10) =>
    db.prepare("INSERT INTO invites (inviter_id, invitee_id, credited_at) VALUES (?, ?, ?)").run(inviter, invitee, creditedAt);
  const ghosted = (userId: string, entryAt = ENTRY) =>
    db.prepare("INSERT INTO events (type, target_id, created_at) VALUES ('ghosted', ?, ?)").run(userId, entryAt);
  const message = (id: string, authorId: string, at: number, surfaceId = "surface-secret") =>
    tc.recordMessage({
      messageId: id,
      authorId,
      surfaceId,
      areaId: surfaceId,
      surfaceKind: "channel",
      replyToMessageId: null,
      createdAtMs: at * 1_000,
      observedAtMs: at * 1_000 + 1,
    });
  const exchange = (prefix: string, userId: string, at: number, surfaceId = `surface-${prefix}`) => {
    message(`${prefix}-subject`, userId, at, surfaceId);
    message(`${prefix}-other`, `other-${prefix}`, at + 10, surfaceId);
  };
  const presence = (userId: string, channelId: string, start: number, end: number) =>
    db
      .prepare(
        `INSERT INTO vc_public_social_presence
           (user_id, guild_id, channel_id, started_at, ended_at, end_quality)
         VALUES (?, 'guild-secret', ?, ?, ?, 'observed')`,
      )
      .run(userId, channelId, start, end);
  const scope = (observedAt = END) => resolveTitleScope(store, RULE.definition, observedAt);
  const read = (userId = "subject", observedAt = END) => readTitleSource(db, "invite_rooted_safe", userId, scope(observedAt));

  return { db, store, invite, ghosted, message, exchange, presence, scope, read };
}

describe("invite_rooted_safe exact semantics", () => {
  it("A–C: confirmed direct relation以外（activity only / hint / self relation）をrootにしない", () => {
    const { db, exchange, read } = setup();
    exchange("activity-only", "unrelated", ENTRY + DAY);
    db.prepare(
      `INSERT INTO souls
         (user_id, status, inviter_hint_user_id, inviter_hint_source, inviter_hint_origin, inviter_hint_at, updated_at)
       VALUES ('hinted', 'waiting', 'subject', 'user', 'gateway', ?, ?)`,
    ).run(ENTRY, ENTRY);
    db.prepare("INSERT INTO invites (inviter_id, invitee_id, credited_at) VALUES ('subject', 'subject', ?)").run(ENTRY + 1);

    expect(read()).toEqual({ profiles: [], unknownEntryAnchorCount: 0 });
  });

  it("D–F: entry後の複数JST日を保持し、同日重複とentry前activityを増幅しない", () => {
    const { invite, ghosted, exchange, read } = setup();
    invite("subject", "branch");
    ghosted("branch");
    exchange("before", "branch", ENTRY - DAY);
    exchange("day1-a", "branch", ENTRY + DAY);
    exchange("day1-b", "branch", ENTRY + DAY + 3_600);
    exchange("day3", "branch", ENTRY + 3 * DAY);

    const profile = read().profiles[0]!;
    expect(profile.activityDays.map((day) => day.dayOffset)).toEqual([1, 3]);
    expect(profile.activityDays[0]).toMatchObject({ tcBestOtherGapMs: 10_000, vcTrustedSocialSeconds: 0 });
  });

  it("G–H: late creditではなくimmutable ghosted eventをanchorにし、event無しlegacy/current soulをunknownにする", () => {
    const { db, invite, ghosted, exchange, read } = setup();
    invite("subject", "late", ENTRY + 10 * DAY);
    ghosted("late", ENTRY);
    db.prepare("INSERT INTO souls (user_id, status, joined_at, ghost_at, updated_at) VALUES ('late', 'ghost', ?, ?, ?)").run(
      ENTRY - 2 * DAY,
      ENTRY + 10 * DAY,
      ENTRY + 10 * DAY,
    );
    exchange("late-day2", "late", ENTRY + 2 * DAY);
    invite("subject", "legacy", ENTRY + 11 * DAY);
    db.prepare("INSERT INTO souls (user_id, status, joined_at, ghost_at, updated_at) VALUES ('legacy', 'ghost', ?, ?, ?)").run(
      ENTRY - DAY,
      ENTRY,
      ENTRY,
    );

    const payload = read();
    expect(payload.unknownEntryAnchorCount).toBe(1);
    expect(payload.profiles).toHaveLength(1);
    expect(payload.profiles[0]!.activityDays.map((day) => day.dayOffset)).toEqual([2]);
  });

  it("I–J: rooted branchのconfirmed next generationを結び、activity無しではrooted条件を満たさない", () => {
    const rooted = setup();
    rooted.invite("subject", "branch");
    rooted.ghosted("branch");
    rooted.exchange("root-day1", "branch", ENTRY + DAY);
    rooted.exchange("root-day3", "branch", ENTRY + 3 * DAY);
    rooted.ghosted("child", ENTRY + 4 * DAY);
    rooted.invite("branch", "child", ENTRY + 4 * DAY + 1);
    const rootedProfile = rooted.read().profiles[0]!;
    expect(rootedProfile.activityDays).toHaveLength(2);
    expect(rootedProfile.nextGenerationOccurrences).toEqual([
      { entryDayOffset: 4, sameDayBeforeEntry: { tcBestOtherGapMs: null, vcTrustedSocialSeconds: 0 } },
    ]);
    expect(rootedProfile.unknownNextGenerationEntryAnchorCount).toBe(0);

    const inactive = setup();
    inactive.invite("subject", "branch");
    inactive.ghosted("branch");
    inactive.ghosted("child", ENTRY + 4 * DAY);
    inactive.invite("branch", "child", ENTRY + 4 * DAY + 1);
    const inactiveProfile = inactive.read().profiles[0]!;
    expect(inactiveProfile.nextGenerationOccurrences).toEqual([
      { entryDayOffset: 4, sameDayBeforeEntry: { tcBestOtherGapMs: null, vcTrustedSocialSeconds: 0 } },
    ]);
    expect(inactiveProfile.activityDays).toEqual([]);
    expect(
      inactive.read().profiles.filter((profile) =>
        profile.nextGenerationOccurrences.some(
          (occurrence) => profile.activityDays.filter((day) => day.dayOffset < occurrence.entryDayOffset).length >= 2,
        ),
      ),
    ).toEqual([]);
  });

  it("K–L: 子の多さはone branchのまま、別々のdirect branchesだけbreadthを増やす", () => {
    const one = setup();
    one.invite("subject", "branch");
    one.ghosted("branch");
    one.exchange("one-root", "branch", ENTRY + DAY);
    for (const [child, day] of [["child-1", 2], ["child-2", 3], ["child-3", 4]] as const) {
      one.ghosted(child, ENTRY + day * DAY);
      one.invite("branch", child, ENTRY + day * DAY + 1);
    }
    expect(one.read().profiles).toHaveLength(1);
    expect(one.read().profiles[0]!.nextGenerationOccurrences.map((occurrence) => occurrence.entryDayOffset)).toEqual([2, 3, 4]);

    const many = setup();
    for (const [branch, child, day] of [
      ["branch-a", "child-a", 2],
      ["branch-b", "child-b", 3],
    ] as const) {
      many.invite("subject", branch);
      many.ghosted(branch);
      many.exchange(`root-${branch}`, branch, ENTRY + DAY);
      many.ghosted(child, ENTRY + day * DAY);
      many.invite(branch, child, ENTRY + day * DAY + 1);
    }
    expect(many.read().profiles).toHaveLength(2);
    expect(many.read().profiles.map((profile) => profile.nextGenerationOccurrences.map((occurrence) => occurrence.entryDayOffset))).toEqual([
      [2],
      [3],
    ]);
  });

  it("M: cycle/selfをnext generationへ数えず、DBのconfirmed relation uniquenessを維持する", () => {
    const { db, invite, ghosted, read } = setup();
    invite("subject", "branch");
    ghosted("branch");
    ghosted("pre-entry-child", ENTRY - DAY);
    invite("branch", "pre-entry-child", ENTRY - 1);
    invite("branch", "subject", ENTRY + DAY);
    expect(read().profiles[0]!.nextGenerationOccurrences).toEqual([
      { entryDayOffset: -1, sameDayBeforeEntry: { tcBestOtherGapMs: null, vcTrustedSocialSeconds: 0 } },
    ]);
    expect(() => invite("someone-else", "branch", ENTRY + 2 * DAY)).toThrow(/UNIQUE/);
    db.prepare("INSERT INTO invites (inviter_id, invitee_id, credited_at) VALUES ('self', 'self', ?)").run(ENTRY + 3 * DAY);
    expect(read("self")).toEqual({ profiles: [], unknownEntryAnchorCount: 0 });
  });

  it("N–O: entry dayを除外し、later dayのpair-specific TC/VC interactionだけをreunionにする", () => {
    const { invite, ghosted, message, presence, read } = setup();
    invite("subject", "branch");
    ghosted("branch");
    message("entry-subject", "subject", ENTRY + 100, "shared");
    message("entry-branch", "branch", ENTRY + 110, "shared");
    message("later-subject", "subject", ENTRY + 2 * DAY, "shared");
    message("later-branch", "branch", ENTRY + 2 * DAY + 15, "shared");
    presence("subject", "shared-vc", ENTRY + 2 * DAY + 100, ENTRY + 2 * DAY + 160);
    presence("branch", "shared-vc", ENTRY + 2 * DAY + 120, ENTRY + 2 * DAY + 180);

    expect(read().profiles[0]!.reunionDays).toEqual([
      { dayOffset: 2, tcBestPairGapMs: 15_000, vcTrustedPairSeconds: 40 },
    ]);
  });

  it("P: unrelated other-human activityをsubject↔invitee interactionへ誤変換しない", () => {
    const { invite, ghosted, message, read } = setup();
    invite("subject", "branch");
    ghosted("branch");
    message("subject", "subject", ENTRY + 2 * DAY, "surface-a");
    message("other", "other", ENTRY + 2 * DAY + 1, "surface-a");
    message("branch", "branch", ENTRY + 2 * DAY + 2, "surface-b");
    message("branch-other", "branch-other", ENTRY + 2 * DAY + 3, "surface-b");

    expect(read().profiles[0]!.activityDays).toHaveLength(1);
    expect(read().profiles[0]!.reunionDays).toEqual([]);
  });

  it("Q: arbitrary/private raw evidenceやcurrent membershipをpublic activityへ使わない", () => {
    const { db, invite, ghosted, read } = setup();
    invite("subject", "branch");
    ghosted("branch");
    const privateVisit = db.prepare(
      `INSERT INTO vc_segments
         (user_id, channel_id, started_at, ended_at, self_muted, self_deafened, end_quality, start_reason)
       VALUES (?, 'private-secret', ?, ?, 0, 0, 'observed', 'join')`,
    );
    privateVisit.run("subject", ENTRY + DAY, ENTRY + DAY + 600);
    privateVisit.run("branch", ENTRY + DAY, ENTRY + DAY + 600);
    db.prepare("INSERT INTO souls (user_id, status, joined_at, ghost_at, updated_at) VALUES ('branch', 'ghost', ?, ?, ?)").run(
      ENTRY - DAY,
      ENTRY,
      END,
    );

    expect(read().profiles[0]).toMatchObject({ activityDays: [], reunionDays: [] });
  });

  it("R: fixed observedAtはlate-observed factsとmutable soul changesを取り込まない", () => {
    const { db, invite, ghosted, exchange, message, read } = setup();
    invite("subject", "branch");
    ghosted("branch");
    exchange("known", "branch", ENTRY + DAY);
    const snapshot = ENTRY + 2 * DAY;
    const before = read("subject", snapshot);

    db.prepare("INSERT INTO souls (user_id, status, joined_at, ghost_at, updated_at) VALUES ('branch', 'departed', 1, NULL, ?)").run(
      snapshot + 1,
    );
    message("late-observed-branch", "branch", ENTRY + DAY + 3_600, "late-surface");
    message("late-observed-other", "late-other", ENTRY + DAY + 3_601, "late-surface");
    db.prepare("UPDATE tc_message_observations SET observed_at_ms = ? WHERE message_id LIKE 'late-observed-%'").run(
      (snapshot + 1) * 1_000,
    );
    invite("subject", "future-branch", snapshot + 1);
    ghosted("future-branch", snapshot + 1);

    expect(read("subject", snapshot)).toEqual(before);
    expect(read("subject", snapshot + 2).profiles).toHaveLength(2);
  });

  it("V: pre-scope direct relation/entryをcontextとして保持し、scope内activityだけをprofile化する", () => {
    const { invite, ghosted, exchange, read } = setup(ENTRY + 10 * DAY);
    ghosted("branch", ENTRY);
    invite("subject", "branch", ENTRY + 1);
    exchange("scope-day12", "branch", ENTRY + 12 * DAY);
    exchange("scope-day15", "branch", ENTRY + 15 * DAY);

    expect(read().profiles[0]!.activityDays.map((day) => day.dayOffset)).toEqual([12, 15]);
  });

  it("W: pre-scope direct relation/entryでもscope内pair reunionを保持する", () => {
    const { invite, ghosted, message, read } = setup(ENTRY + 10 * DAY);
    ghosted("branch", ENTRY);
    invite("subject", "branch", ENTRY + 1);
    message("reunion-subject", "subject", ENTRY + 12 * DAY, "shared-surface");
    message("reunion-branch", "branch", ENTRY + 12 * DAY + 7, "shared-surface");

    expect(read().profiles[0]!.reunionDays).toEqual([
      { dayOffset: 12, tcBestPairGapMs: 7_000, vcTrustedPairSeconds: 0 },
    ]);
  });

  it("X: relation contextがpre-scopeでもactivity/reunion evidence自体はscope startでclipする", () => {
    const { invite, ghosted, exchange, message, read } = setup(ENTRY + 10 * DAY);
    ghosted("branch", ENTRY);
    invite("subject", "branch", ENTRY + 1);
    exchange("before-scope", "branch", ENTRY + 2 * DAY);
    message("before-reunion-subject", "subject", ENTRY + 3 * DAY, "shared-surface");
    message("before-reunion-branch", "branch", ENTRY + 3 * DAY + 5, "shared-surface");

    expect(read().profiles[0]).toMatchObject({ activityDays: [], reunionDays: [] });
  });

  it("Y: childの実entryがrooted activityより先ならlate staff creditでcascadeへ反転しない", () => {
    const { invite, ghosted, exchange, read } = setup();
    ghosted("branch", ENTRY);
    invite("subject", "branch", ENTRY + 1);
    ghosted("child", ENTRY + 2 * DAY);
    exchange("root-day4", "branch", ENTRY + 4 * DAY);
    exchange("root-day6", "branch", ENTRY + 6 * DAY);
    invite("branch", "child", ENTRY + 8 * DAY);

    const profile = read().profiles[0]!;
    expect(profile.nextGenerationOccurrences.map((occurrence) => occurrence.entryDayOffset)).toEqual([2]);
    expect(profile.activityDays.map((day) => day.dayOffset)).toEqual([4, 6]);
    expect(profile.activityDays.filter((day) => day.dayOffset < profile.nextGenerationOccurrences[0]!.entryDayOffset).length).toBe(0);
  });

  it("Z: branchが先にrootedし、その後にcanonical child entryがあるchronologyを表現する", () => {
    const { invite, ghosted, exchange, read } = setup();
    ghosted("branch", ENTRY);
    invite("subject", "branch", ENTRY + 1);
    exchange("root-day1", "branch", ENTRY + DAY);
    exchange("root-day3", "branch", ENTRY + 3 * DAY);
    ghosted("child", ENTRY + 5 * DAY);
    invite("branch", "child", ENTRY + 7 * DAY);

    const profile = read().profiles[0]!;
    expect(profile.nextGenerationOccurrences.map((occurrence) => occurrence.entryDayOffset)).toEqual([5]);
    expect(profile.activityDays.map((day) => day.dayOffset)).toEqual([1, 3]);
  });

  it("AA: child-before-rootとroot-before-childをsafe payloadだけで区別できる", () => {
    const { invite, ghosted, exchange, read } = setup();
    for (const branch of ["child-first", "root-first"]) {
      ghosted(branch, ENTRY);
      invite("subject", branch, ENTRY + 1);
    }
    ghosted("early-child", ENTRY + DAY);
    invite("child-first", "early-child", ENTRY + 4 * DAY);
    exchange("child-first-root", "child-first", ENTRY + 3 * DAY);
    exchange("root-first-root", "root-first", ENTRY + DAY);
    ghosted("later-child", ENTRY + 3 * DAY);
    invite("root-first", "later-child", ENTRY + 4 * DAY);

    expect(
      read().profiles.map((profile) => ({
        activity: profile.activityDays.map((day) => day.dayOffset),
        children: profile.nextGenerationOccurrences.map((occurrence) => occurrence.entryDayOffset),
      })),
    ).toEqual([
      { activity: [1], children: [3] },
      { activity: [3], children: [1] },
    ]);
  });

  it("AB: future thresholdはnext-generation entryより前のrooted daysだけでqualifying branchを数えられる", () => {
    const { invite, ghosted, exchange, read } = setup();
    for (const branch of ["qualifying", "too-late"]) {
      ghosted(branch, ENTRY);
      invite("subject", branch, ENTRY + 1);
    }
    exchange("qualifying-day1", "qualifying", ENTRY + DAY);
    exchange("qualifying-day2", "qualifying", ENTRY + 2 * DAY);
    ghosted("qualifying-child", ENTRY + 4 * DAY);
    invite("qualifying", "qualifying-child", ENTRY + 5 * DAY);
    ghosted("too-late-child", ENTRY + DAY);
    invite("too-late", "too-late-child", ENTRY + 5 * DAY);
    exchange("too-late-day2", "too-late", ENTRY + 2 * DAY);
    exchange("too-late-day3", "too-late", ENTRY + 3 * DAY);

    // 2日はfixture上のcalibration例。source自身は閾値を固定しない。
    const qualifying = read().profiles.filter((profile) =>
      profile.nextGenerationOccurrences.some(
        (occurrence) => profile.activityDays.filter((day) => day.dayOffset < occurrence.entryDayOffset).length >= 2,
      ),
    );
    expect(qualifying).toHaveLength(1);
    expect(qualifying[0]!.nextGenerationOccurrences.map((occurrence) => occurrence.entryDayOffset)).toEqual([4]);
  });

  it("AC: child immutable entry event欠如をcredited_at/current soulから推測しない", () => {
    const { db, invite, ghosted, read } = setup();
    ghosted("branch", ENTRY);
    invite("subject", "branch", ENTRY + 1);
    invite("branch", "legacy-child", ENTRY + 4 * DAY);
    db.prepare("INSERT INTO souls (user_id, status, joined_at, ghost_at, updated_at) VALUES ('legacy-child', 'ghost', ?, ?, ?)").run(
      ENTRY + 2 * DAY,
      ENTRY + 3 * DAY,
      ENTRY + 4 * DAY,
    );

    expect(read().profiles[0]).toMatchObject({
      nextGenerationOccurrences: [],
      unknownNextGenerationEntryAnchorCount: 1,
    });
  });

  it("AD: fixed observedAtより後にconfirmされたdirect relationはそのsnapshotへ出さない", () => {
    const { invite, ghosted, exchange, read } = setup();
    const snapshot = ENTRY + 2 * DAY;
    ghosted("branch", ENTRY);
    exchange("known-activity", "branch", ENTRY + DAY);
    invite("subject", "branch", snapshot + 1);

    expect(read("subject", snapshot)).toEqual({ profiles: [], unknownEntryAnchorCount: 0 });
    expect(read("subject", snapshot + 2).profiles[0]!.activityDays.map((day) => day.dayOffset)).toEqual([1]);
  });

  it("AE: No.74/75 confirmed_invitesはpre-scope relationを引き続き除外する", () => {
    const { db, invite, scope } = setup(ENTRY + 10 * DAY);
    invite("subject", "before-scope", ENTRY + 1);
    invite("subject", "inside-scope", ENTRY + 12 * DAY);

    expect(readTitleSource(db, "confirmed_invites", "subject", scope()).creditedAt).toEqual([ENTRY + 12 * DAY]);
  });

  it("AF: earlier day + child-day entry前activityをfuture 2-day rooted条件へ使える", () => {
    const { invite, ghosted, exchange, read } = setup();
    const childEntryAt = ENTRY + 3 * DAY + 8 * HOUR;
    ghosted("branch", ENTRY);
    invite("subject", "branch", ENTRY + 1);
    exchange("root-day1", "branch", ENTRY + DAY);
    exchange("root-child-day-before", "branch", childEntryAt - HOUR);
    ghosted("child", childEntryAt);
    invite("branch", "child", childEntryAt + 1);

    const profile = read().profiles[0]!;
    const occurrence = profile.nextGenerationOccurrences[0]!;
    const earlierDays = profile.activityDays.filter((day) => day.dayOffset < occurrence.entryDayOffset);
    expect(earlierDays.map((day) => day.dayOffset)).toEqual([1]);
    expect(occurrence).toEqual({
      entryDayOffset: 3,
      sameDayBeforeEntry: { tcBestOtherGapMs: 10_000, vcTrustedSocialSeconds: 0 },
    });
    expect(earlierDays.length + (occurrence.sameDayBeforeEntry.tcBestOtherGapMs === null ? 0 : 1)).toBe(2);
  });

  it("AG: child-day activityがentry後だけならroot-before-child prefixへ入れない", () => {
    const { invite, ghosted, exchange, read } = setup();
    const childEntryAt = ENTRY + 3 * DAY + 8 * HOUR;
    ghosted("branch", ENTRY);
    invite("subject", "branch", ENTRY + 1);
    exchange("root-day1", "branch", ENTRY + DAY);
    ghosted("child", childEntryAt);
    invite("branch", "child", childEntryAt + 1);
    exchange("root-child-day-after", "branch", childEntryAt + HOUR);

    const profile = read().profiles[0]!;
    expect(profile.activityDays.map((day) => day.dayOffset)).toEqual([1, 3]);
    expect(profile.nextGenerationOccurrences[0]).toEqual({
      entryDayOffset: 3,
      sameDayBeforeEntry: { tcBestOtherGapMs: null, vcTrustedSocialSeconds: 0 },
    });
  });

  it("AH: same JST dayの2 childをactivity前後のanonymous occurrencesとして区別する", () => {
    const { invite, ghosted, exchange, read } = setup();
    const activityAt = ENTRY + 3 * DAY + 5 * HOUR;
    ghosted("branch", ENTRY);
    invite("subject", "branch", ENTRY + 1);
    ghosted("child-before-activity", activityAt - 2 * HOUR);
    exchange("between-children", "branch", activityAt);
    ghosted("child-after-activity", activityAt + 2 * HOUR);
    invite("branch", "child-before-activity", activityAt + 3 * HOUR);
    invite("branch", "child-after-activity", activityAt + 3 * HOUR + 1);

    expect(read().profiles[0]!.nextGenerationOccurrences).toEqual([
      { entryDayOffset: 3, sameDayBeforeEntry: { tcBestOtherGapMs: 10_000, vcTrustedSocialSeconds: 0 } },
      { entryDayOffset: 3, sameDayBeforeEntry: { tcBestOtherGapMs: null, vcTrustedSocialSeconds: 0 } },
    ]);
  });

  it("AI: TC exchangeのsubject/other両端をchild entryで正確にclipする", () => {
    const { invite, ghosted, message, read } = setup();
    const childEntryAt = ENTRY + 3 * DAY + 8 * HOUR;
    ghosted("branch", ENTRY);
    invite("subject", "branch", ENTRY + 1);
    message("eligible-subject", "branch", childEntryAt - 2_000, "eligible-surface");
    message("eligible-other", "eligible-other", childEntryAt - 1_000, "eligible-surface");
    message("crossing-subject", "branch", childEntryAt - 10, "crossing-surface");
    message("crossing-other", "crossing-other", childEntryAt + 10, "crossing-surface");
    ghosted("child", childEntryAt);
    invite("branch", "child", childEntryAt + 20);

    const profile = read().profiles[0]!;
    expect(profile.activityDays[0]).toMatchObject({ dayOffset: 3, tcBestOtherGapMs: 20_000 });
    expect(profile.nextGenerationOccurrences[0]!.sameDayBeforeEntry.tcBestOtherGapMs).toBe(1_000_000);
  });

  it("AJ: child entryを跨ぐVC intervalはentryまでのtrusted secondsだけをprefixへ入れる", () => {
    const { invite, ghosted, presence, read } = setup();
    const childEntryAt = ENTRY + 3 * DAY + 8 * HOUR;
    ghosted("branch", ENTRY);
    invite("subject", "branch", ENTRY + 1);
    presence("branch", "crossing-vc", childEntryAt - 600, childEntryAt + 600);
    ghosted("child", childEntryAt);
    invite("branch", "child", childEntryAt + 1_200);

    const profile = read().profiles[0]!;
    expect(profile.activityDays[0]).toMatchObject({ dayOffset: 3, vcTrustedSocialSeconds: 1_200 });
    expect(profile.nextGenerationOccurrences[0]).toEqual({
      entryDayOffset: 3,
      sameDayBeforeEntry: { tcBestOtherGapMs: null, vcTrustedSocialSeconds: 600 },
    });
  });

  it("S: safe payloadはidentity/exact date/timestampを出さず全階層をdeep-freezeする", () => {
    const { invite, ghosted, exchange, read } = setup();
    invite("subject-secret-marker", "branch-secret-marker");
    ghosted("branch-secret-marker");
    exchange("message-secret-marker", "branch-secret-marker", ENTRY + DAY, "surface-secret-marker");
    ghosted("child-secret-marker", ENTRY + 2 * DAY);
    invite("branch-secret-marker", "child-secret-marker", ENTRY + 2 * DAY + 1);
    const payload = read("subject-secret-marker");
    const json = JSON.stringify(payload);
    for (const marker of [
      "subject-secret-marker",
      "branch-secret-marker",
      "child-secret-marker",
      "surface-secret-marker",
      "message-secret-marker",
      "2026-",
    ]) {
      expect(json).not.toContain(marker);
    }
    expect(json).not.toMatch(/user_?id|invitee|inviter|surface|channel|guild|created_at|credited_at|entry_at/i);
    for (const value of [
      payload,
      payload.profiles,
      payload.profiles[0],
      payload.profiles[0]!.activityDays,
      payload.profiles[0]!.activityDays[0],
      payload.profiles[0]!.nextGenerationOccurrences,
      payload.profiles[0]!.nextGenerationOccurrences[0],
      payload.profiles[0]!.nextGenerationOccurrences[0]!.sameDayBeforeEntry,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(() => ((payload.profiles[0]!.activityDays[0] as { dayOffset: number }).dayOffset = 99)).toThrow();
  });

  it("T: 301 subjects / 602 participantsを300-user chunksでbounded bulk readする", () => {
    const { db, invite, ghosted, scope } = setup();
    db.transaction(() => {
      for (let index = 0; index < 301; index += 1) {
        invite(`subject-${index}`, `branch-${index}`);
        ghosted(`branch-${index}`);
      }
    })();
    const users = Array.from({ length: 301 }, (_, index) => `subject-${index}`);
    const spy = vi.spyOn(db, "prepare");
    const cache = new TitleSourceCache();
    expect(cache.prefetch(db, "invite_rooted_safe", users, scope())).toEqual({ loaded: 301, readCalls: 2 });
    expect(cache.get(db, "invite_rooted_safe", "subject-300", scope()).profiles).toHaveLength(1);
    const sql = spy.mock.calls.map(([text]) => String(text));
    expect(Math.max(...sql.map((text) => text.match(/\?/g)?.length ?? 0))).toBeLessThanOrEqual(303);
    expect(sql.filter((text) => /(?:inviter_id|invitee_id|author_id|user_id)\s*=\s*\?/.test(text))).toHaveLength(0);
    expect(sql.length).toBeLessThanOrEqual(24);
  });

  it("U: derived read failureはEntry/confirmed invite writerへwiringされずonboardingを阻害しない", () => {
    const failedDb = openDb(":memory:");
    failedDb.close();
    expect(() => computeInviteRootedSafe(failedDb, { start: START, end: END, observedAt: END }, ["subject"])).toThrow();

    const db = openDb(":memory:");
    const entry = new Entry(db, new Ledger(db), new Settings(db), new EventLog(db));
    entry.book("branch", "flex", { userId: "subject", source: "user" });
    entry.ghostify("branch", "staff");
    expect(db.prepare("SELECT inviter_id, invitee_id FROM invites").get()).toEqual({ inviter_id: "subject", invitee_id: "branch" });

    const entrySource = readFileSync(new URL("../src/entry/service.ts", import.meta.url), "utf8");
    const botSource = readFileSync(new URL("../../../apps/bot/src/index.ts", import.meta.url), "utf8");
    expect(entrySource).not.toContain("computeInviteRootedSafe");
    expect(entrySource).not.toContain("invite_rooted_safe");
    expect(botSource).not.toContain("computeInviteRootedSafe");
  });
});

describe("invite_rooted_safe source contract", () => {
  it("restricted raw sourcesをgeneric readへ出さず、safe derived contractだけを公開する", () => {
    const { db, scope } = setup();
    expect(TITLE_SOURCES.invite_rooted_safe).toEqual({
      origin: "derived",
      derivedBy: {
        file: "packages/core/src/titles/v2-invite-rooted.ts",
        needle: "export function computeInviteRootedSafe(",
      },
      derivedFrom: [
        "confirmed_invite_relations",
        "entry_ghosted_events",
        "tc_message_observations",
        "vc_public_social_presence",
      ],
      kind: "history",
      privacy: "safe",
      orderable: false,
      titleUsable: true,
      epochPolicy: { type: "interval", start: "windowStart", end: "windowEnd", clip: true },
      rawUnit: "anonymous_confirmed_direct_invite_rooted_network_reunion_distribution",
    });
    expect(TITLE_SOURCES.entry_ghosted_events).toMatchObject({
      origin: "persisted",
      privacy: "restricted",
      orderable: true,
      titleUsable: false,
      restrictedUse: "invite_rooted_safe_classification",
    });
    expect(TITLE_SOURCES.confirmed_invite_relations).toMatchObject({
      origin: "persisted",
      privacy: "restricted",
      orderable: true,
      titleUsable: false,
      restrictedUse: "invite_rooted_safe_classification",
    });
    expect(() => readTitleSource(db, "confirmed_invite_relations" as never, "subject", scope())).toThrow(/not usable/);
    expect(() => readTitleSource(db, "entry_ghosted_events" as never, "subject", scope())).toThrow(/not usable/);
    expect(() => readTitleSource(db, "tc_message_observations" as never, "subject", scope())).toThrow(/not usable/);
    expect(() => readTitleSource(db, "vc_public_social_presence" as never, "subject", scope())).toThrow(/not usable/);
  });
});
