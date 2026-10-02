import { RawSubtitleItem } from '../types/provider';
import { rankSubtitles, DEFAULT_RULES, RuleFlags } from './scorer';

/**
 * What each optional scoring rule changes on the requests really made: the stored ranking of every request (best 12
 * and the rejected ones, with the file name) is ranked again with the rule flipped, and the first subtitle (the one
 * the player picks) is compared. Only what changes the player's pick is counted.
 */

export interface StoredRequest {
  at: string;
  id: string;
  filename?: string | null;
  top: Array<{ provider: string; release: string; reasons: string[]; rejected: boolean }>;
  providerPriority?: string[];
}

export interface RuleImpact {
  rule: keyof RuleFlags;
  on: boolean;
  description: string;
  evaluated: number;
  changed: number;
  examples: Array<{ at: string; file: string; now: string; flipped: string }>;
}

const DESCRIPTIONS: Record<keyof RuleFlags, string> = {
  fuzzyGroup: 'a group with a tracker suffix ("DEMAND" / "DEMANDrarbg") counts as a partial group match',
  sourceTiers: 'neighbouring sources (BluRay / WEB-DL, WEB / HDTV) get partial credit instead of a penalty',
  multiVariant: 'names listing several releases ("A; B", "[Release]") are scored by their best variant',
  exactTier: 'a name that is exactly the file\'s release is on top with the hash matches, the priority deciding'
};

const seasonEpisode = (id: string): { season: number | null; episode: number | null } => {
  const parts = id.split(':');
  if (parts[0] === 'kitsu') return { season: null, episode: parts[2] ? parseInt(parts[2], 10) : null };
  return parts.length >= 3 ? { season: parseInt(parts[1], 10), episode: parseInt(parts[2], 10) } : { season: null, episode: null };
};

export function computeRuleImpact(requests: StoredRequest[], priority: string[] = []): { requests: number; rules: RuleImpact[] } {
  const usable = requests.filter(r => r.filename && r.top && r.top.length >= 2);
  const rules = (Object.keys(DEFAULT_RULES) as Array<keyof RuleFlags>).map(rule => {
    const on = DEFAULT_RULES[rule];
    const impact: RuleImpact = { rule, on, description: DESCRIPTIONS[rule], evaluated: 0, changed: 0, examples: [] };
    for (const r of usable) {
      const items: RawSubtitleItem[] = r.top.map((t, i) => ({
        id: `${i}`, provider: t.provider, providerName: t.provider, url: '/x', lang: 'und', release: t.release,
        ...(t.reasons.some(x => /HASH MATCH/.test(x)) ? { hashMatch: true } : {})
      }));
      const ctx = { filename: r.filename, ...seasonEpisode(r.id), providerBonus: { subsro: 8 }, providerPriority: r.providerPriority || priority };
      const now = rankSubtitles(items, ctx).items[0];
      const flipped = rankSubtitles(items, { ...ctx, rules: { [rule]: !on } }).items[0];
      impact.evaluated++;
      if (now && flipped && now.id !== flipped.id) {
        impact.changed++;
        if (impact.examples.length < 10) {
          impact.examples.push({ at: r.at, file: r.filename || '', now: `[${now.provider}] ${now.release}`, flipped: `[${flipped.provider}] ${flipped.release}` });
        }
      }
    }
    return impact;
  });
  return { requests: usable.length, rules };
}
