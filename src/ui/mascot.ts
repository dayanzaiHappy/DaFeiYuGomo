export type MascotState = 'idle' | 'thinking' | 'happy' | 'worried';

/**
 * 原创抽象蓝鲸鱼团子。刻意不使用“溟月”/同人图的可识别组合：
 * 没有长发、鲸鳍、女仆装，只保留圆润蓝色身体、白肚皮和小鳍。
 */
export function mascotSvg(state: MascotState = 'idle'): string {
  const eyes =
    state === 'happy'
      ? `
        <path d="M45 61 Q49 56 53 61" fill="none" stroke="#17324d" stroke-width="3" stroke-linecap="round"/>
        <path d="M67 61 Q71 56 75 61" fill="none" stroke="#17324d" stroke-width="3" stroke-linecap="round"/>
      `
      : state === 'worried'
        ? `
          <circle cx="49" cy="62" r="3.2" fill="#17324d"/>
          <circle cx="71" cy="62" r="3.2" fill="#17324d"/>
          <path d="M43 54 Q49 51 54 54" fill="none" stroke="#17324d" stroke-width="2.4" stroke-linecap="round"/>
          <path d="M66 54 Q71 51 77 54" fill="none" stroke="#17324d" stroke-width="2.4" stroke-linecap="round"/>
        `
        : state === 'thinking'
          ? `
            <circle cx="50" cy="60" r="3.2" fill="#17324d"/>
            <circle cx="72" cy="60" r="3.2" fill="#17324d"/>
            <circle cx="52" cy="58.8" r="1.1" fill="#ffffff"/>
            <circle cx="74" cy="58.8" r="1.1" fill="#ffffff"/>
          `
          : `
            <circle cx="49" cy="61" r="3.4" fill="#17324d"/>
            <circle cx="71" cy="61" r="3.4" fill="#17324d"/>
            <circle cx="50.2" cy="59.8" r="1.2" fill="#ffffff"/>
            <circle cx="72.2" cy="59.8" r="1.2" fill="#ffffff"/>
          `;

  const mouth =
    state === 'happy'
      ? '<path d="M52 74 Q60 84 68 74" fill="none" stroke="#17324d" stroke-width="3" stroke-linecap="round"/>'
      : state === 'worried'
        ? '<path d="M54 78 Q60 74 66 78" fill="none" stroke="#17324d" stroke-width="2.6" stroke-linecap="round"/>'
        : state === 'thinking'
          ? '<ellipse cx="60" cy="77" rx="4" ry="3.4" fill="#17324d"/>'
          : '<path d="M54 75 Q60 80 66 75" fill="none" stroke="#17324d" stroke-width="2.8" stroke-linecap="round"/>';

  const bubbles =
    state === 'thinking'
      ? `
        <circle cx="88" cy="38" r="3" fill="#cfeaff" opacity="0.9"/>
        <circle cx="96" cy="29" r="2.2" fill="#cfeaff" opacity="0.7"/>
        <circle cx="102" cy="22" r="1.5" fill="#cfeaff" opacity="0.5"/>
      `
      : '';

  return `
  <svg viewBox="0 0 120 120" class="mascot-svg mascot-${state}" role="img" aria-label="蓝色大肥鱼">
    <defs>
      <radialGradient id="fish-body" cx="36%" cy="28%" r="78%">
        <stop offset="0%" stop-color="#9fd8ff"/>
        <stop offset="52%" stop-color="#4d9ff0"/>
        <stop offset="100%" stop-color="#1e5fa8"/>
      </radialGradient>
      <radialGradient id="fish-belly" cx="50%" cy="42%" r="70%">
        <stop offset="0%" stop-color="#ffffff"/>
        <stop offset="100%" stop-color="#d7edff"/>
      </radialGradient>
      <radialGradient id="stone" cx="35%" cy="30%" r="75%">
        <stop offset="0%" stop-color="#5c5c5c"/>
        <stop offset="100%" stop-color="#0a0a0a"/>
      </radialGradient>
    </defs>
    <ellipse cx="60" cy="92" rx="34" ry="6" fill="#0b1b33" opacity="0.18"/>
    <path d="M30 70 C16 60 14 80 24 86 C30 89 36 84 38 78 Z" fill="#3f8edb"/>
    <path d="M90 70 C104 60 106 80 96 86 C90 89 84 84 82 78 Z" fill="#3f8edb"/>
    <ellipse cx="60" cy="67" rx="39" ry="31" fill="url(#fish-body)"/>
    <ellipse cx="60" cy="79" rx="25" ry="15" fill="url(#fish-belly)"/>
    <path d="M56 38 Q60 30 64 38" fill="none" stroke="#2c74bd" stroke-width="3" stroke-linecap="round"/>
    <circle cx="60" cy="28" r="6.5" fill="url(#stone)" stroke="#ffffff" stroke-width="1.6"/>
    <circle cx="58" cy="26" r="1.5" fill="#ffffff" opacity="0.75"/>
    ${eyes}
    ${mouth}
    <ellipse cx="38" cy="72" rx="6" ry="4" fill="#ff9fb3" opacity="0.55"/>
    <ellipse cx="82" cy="72" rx="6" ry="4" fill="#ff9fb3" opacity="0.55"/>
    ${bubbles}
  </svg>`;
}
