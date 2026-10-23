import type { Doc, Hit, MappingSnapshot, RestoreReport, Settings } from '../engine/light';
import type { MaskResult } from '../engine/mask';

export interface AnalyzeReq {
  type: 'analyze';
  docKey: string;
  text: string;
  settings: Settings;
  fileName?: string;
}
export interface AnalyzeRes {
  hits: Hit[];
  format: Doc['format'];
  lang?: Doc['lang'];
  ms: number;
}
export interface MaskReq {
  type: 'mask';
  docKey: string;
  text: string;
  settings: Settings;
  fileName?: string;
  format: Doc['format'];
  lang?: Doc['lang'];
  hits: Hit[];
  mapping: MappingSnapshot;
}
export interface MaskRes extends Omit<MaskResult, 'skipped'> {
  skipped: Hit[];
  mapping: MappingSnapshot;
}
export interface RegexTestReq {
  type: 'regex';
  pattern: string;
  flags: string;
  sample: string;
}
export interface RegexTestRes {
  error?: string;
  matches: [number, number][];
}
export interface RestoreReq {
  type: 'restore';
  text: string;
  mapping: MappingSnapshot;
  expected: string[];
}

export type Req = AnalyzeReq | MaskReq | RegexTestReq | RestoreReq;
export type Reply = { ok: true; result: AnalyzeRes | MaskRes | RegexTestRes | RestoreReport } | { ok: false; error: string };
export type Msg = { id: number } & Reply;
export type ReqWithId = { id: number; req: Req };
