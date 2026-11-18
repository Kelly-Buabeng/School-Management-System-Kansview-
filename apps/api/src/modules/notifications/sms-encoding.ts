// Owner: Agent F. SMS length and cost maths (GSM 03.38).

const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\u001bÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXTENSION = '^{}\\[~]|€\f';

const BASIC = new Set(GSM7_BASIC);
const EXT = new Set(GSM7_EXTENSION);

export type SmsEncoding = 'GSM-7' | 'UCS-2';

export interface SmsInfo {
  encoding: SmsEncoding;
  /** Septets for GSM-7 (extension characters count twice), UTF-16 code units for UCS-2. */
  units: number;
  segments: number;
  /** Characters still available in the last segment. */
  remainingInSegment: number;
}

export function detectEncoding(text: string): SmsEncoding {
  for (const ch of text) if (!BASIC.has(ch) && !EXT.has(ch)) return 'UCS-2';
  return 'GSM-7';
}

export function smsInfo(text: string): SmsInfo {
  const encoding = detectEncoding(text);
  let units = 0;
  if (encoding === 'GSM-7') {
    for (const ch of text) units += EXT.has(ch) ? 2 : 1;
  } else {
    units = text.length; // UTF-16 code units; emoji take 2
  }
  const single = encoding === 'GSM-7' ? 160 : 70;
  const multi = encoding === 'GSM-7' ? 153 : 67;
  const segments = units === 0 ? 0 : units <= single ? 1 : Math.ceil(units / multi);
  const capacity = segments <= 1 ? single : segments * multi;
  return { encoding, units, segments, remainingInSegment: capacity - units };
}

/** Default price per SMS segment in pesewas when the provider has not told us otherwise (estimate only). */
export const DEFAULT_PESEWAS_PER_SEGMENT = 3;

export function estimateCostPesewas(totalSegments: number, pesewasPerSegment = DEFAULT_PESEWAS_PER_SEGMENT): number {
  return totalSegments * pesewasPerSegment;
}
