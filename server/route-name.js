import { probeTokenPricing } from './user-groups.js'

// Keep upstream key names and stable IDs intact; this is only a display label.
export function probeRouteName(channel, token) {
  const pricing = probeTokenPricing(channel, token), recharge = channel.rechargeRate ?? 1
  const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
  const format = value => `${Number(value.toPrecision(8))}×`
  let rate = '倍率未知'
  if (pricing.source !== 'automatic' && valid(pricing.rate) && valid(recharge) && recharge > 0) {
    const actual = pricing.rate / recharge, peak = pricing.peak ? actual * pricing.peak.factor : actual
    if (valid(actual) && valid(peak) && (!pricing.peak || valid(pricing.peak.factor))) {
      rate = actual === peak ? format(actual) : `${format(Math.min(actual, peak))}–${format(Math.max(actual, peak))}`
    }
  }
  const suffix = ` · ${rate}`
  const chars = Array.from(String(channel.name ?? '').trim().replace(/\s+/g, ' ') || '未命名站点')
  // Sub2API limits account names to 100 bytes. Preserve the rate suffix.
  while (chars.length && Buffer.byteLength(chars.join('') + suffix) > 100) chars.pop()
  return chars.join('') + suffix
}
