import { Paginated } from './pagination.jsx'
import { useEffect, useRef, useState } from 'react'
import { ArrowSquareOut, ArrowsClockwise, CheckCircle, Eye, EyeSlash, Wallet, X } from '@phosphor-icons/react'
import { QRCodeSVG } from 'qrcode.react'
import { requestJSON } from './console-fetch.js'
import './channel-funding.css'

const money = (value, currency) => `${currency || '金额'} ${Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 3 })}`
const orderLabels = { PENDING: '待支付', PAID: '已支付，等待入账', RECHARGING: '正在入账', COMPLETED: '已到账',
  EXPIRED: '已过期', CANCELLED: '已取消', FAILED: '失败', success: '已到账', pending: '待支付' }

export function FundingDialog({ channel, onClose, onChanged }) {
  const dialog = useRef(null)
  const [tab, setTab] = useState('redeem')
  const [options, setOptions] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [code, setCode] = useState('')
  const [visible, setVisible] = useState(false)
  const [method, setMethod] = useState('')
  const [amount, setAmount] = useState('')
  const [quote, setQuote] = useState(null)
  const [result, setResult] = useState(null)
  const [reload, setReload] = useState(0)
  const requestId = useRef(crypto.randomUUID())
  const submitting = useRef(false)
  const request = (action, body, signal) => requestJSON(`/api/upstream-channels/${encodeURIComponent(channel.id)}/funding/${action}`, body, signal)
  useEffect(() => {
    const element = dialog.current
    element.showModal()
    return () => element.close()
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    request('options', null, controller.signal).then(payload => {
      if (controller.signal.aborted) return
      setOptions(payload)
      setMethod(payload.methods[0]?.id || '')
      if (payload.latest && (payload.latest.status === 'unknown' || payload.latest.order)) setResult(payload.latest)
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [channel.id, reload])

  async function run(action) {
    if (submitting.current) return
    submitting.current = true; setBusy(true); setError('')
    try {
      const body = action === 'redeem' ? { code: code.trim(), requestId: requestId.current }
        : action === 'quote' ? { method, amount: Number(amount) }
        : action === 'pay' ? { quoteId: quote.id } : { id: result.id }
      const payload = await request(action, body)
      if (action === 'quote') { setQuote(payload.quote); setResult(null) }
      else {
        setResult(payload.result)
        if (action === 'redeem') { setCode(''); requestId.current = crypto.randomUUID() }
        if (action === 'pay') setQuote(null)
        if (action === 'redeem' || action === 'status') onChanged()
      }
    } catch (failure) {
      const requote = action === 'pay' && ['QUOTE_EXPIRED', 'QUOTE_CHANGED'].includes(failure.code)
      if (requote) setQuote(null)
      setError(requote ? `${failure.message} 本次未创建订单。` : action === 'redeem' || action === 'pay'
        ? `${failure.message} 若请求已发出，请先核对上游记录；重复点击会查询同一次提交，不会自动新建。` : failure.message)
    } finally { submitting.current = false; setBusy(false) }
  }
  function resetResult() { setResult(null); setQuote(null); setError(''); requestId.current = crypto.randomUUID() }
  const selected = options?.methods.find(item => item.id === method)
  const blockingResult = result && result.status !== 'rejected'
  const orderPayable = result?.order && (!result.order.status || ['PENDING', 'pending'].includes(result.order.status))

  return <dialog className="add-modal funding-dialog" ref={dialog} aria-labelledby="funding-title" onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <div className="modal-head"><div><span className="eyebrow">{channel.provider}</span><h2 id="funding-title">充值与兑换</h2></div><button type="button" className="icon-button" aria-label="关闭充值与兑换" disabled={busy} onClick={onClose}><X size={18} /></button></div>
    <div className="funding-account"><Wallet size={20} /><div><strong>{channel.name}</strong><span>{channel.endpoint}</span></div></div>
    <p className="funding-description">充值或兑换将计入此渠道的上游账户。</p>
    {loading ? <p role="status" className="funding-description">正在读取上游充值方式…</p> : options && <>
      {options.notice && <p className="funding-notice">{options.notice}</p>}
      {!blockingResult && <>
        {(options.purchaseLinks?.length > 0 || !options.methods.length) && <section className="funding-purchase" aria-label="购买兑换码">
          <h3>购买兑换码</h3>
          {options.purchaseLinks?.length ? <><p>以下为上游提供的购买 / 充值入口，购买兑换码后可回到此处兑换。</p>
            <Paginated items={options.purchaseLinks} label="兑换码购买地址">{links => <ul>{links.map(link => <li key={link.url}><a href={link.url} target="_blank" rel="noopener noreferrer"><span><b>{link.name}</b><small>{link.host}</small></span><ArrowSquareOut size={17} /></a></li>)}</ul>}</Paginated>
          </> : <p>{options.purchaseNotice || '上游未提供兑换码购买地址，请前往上游查看或联系站点客服。'}</p>}
        </section>}
        <div className="funding-tabs" role="tablist" aria-label="充值方式"><button id="funding-redeem-tab" role="tab" aria-selected={tab === 'redeem'} aria-controls="funding-redeem" disabled={busy} onClick={() => { setTab('redeem'); setError(''); setQuote(null) }}>兑换码</button><button id="funding-pay-tab" role="tab" aria-selected={tab === 'pay'} aria-controls="funding-pay" disabled={busy} onClick={() => { setTab('pay'); setError('') }}>在线充值{options.methods.length ? ` · ${options.methods.length}` : ''}</button></div>
        {tab === 'redeem' ? <form id="funding-redeem" role="tabpanel" aria-labelledby="funding-redeem-tab" onSubmit={event => { event.preventDefault(); void run('redeem') }}>
          {options.redeem ? <><label htmlFor="funding-code">兑换码 / 激活码</label><div className="secret-input"><input id="funding-code" name="redeem-code" type={visible ? 'text' : 'password'} autoComplete="off" spellCheck={false} placeholder="输入此上游站点的兑换码" maxLength={256} required value={code} disabled={busy} onChange={event => { setCode(event.target.value); requestId.current = crypto.randomUUID(); setResult(null) }} /><button type="button" aria-label={visible ? '隐藏兑换码' : '显示兑换码'} aria-controls="funding-code" aria-pressed={visible} onClick={() => setVisible(value => !value)}>{visible ? <EyeSlash size={17} /> : <Eye size={17} />}</button></div><small className="field-hint">确认后立即提交到 {channel.name}，兑换成功后自动刷新余额。兑换码不会保存在本站。</small><button className="probe-button funding-primary" type="submit" disabled={busy || !code.trim()}>{busy ? '正在兑换…' : '确认兑换'}</button></> : <p className="funding-description">上游当前未开放兑换码功能。</p>}
        </form> : <form id="funding-pay" role="tabpanel" aria-labelledby="funding-pay-tab" onSubmit={event => { event.preventDefault(); void run(quote ? 'pay' : 'quote') }}>
          {options.methods.length ? <><label htmlFor="funding-method">支付方式</label><select id="funding-method" disabled={busy} value={method} onChange={event => { setMethod(event.target.value); setQuote(null); setError('') }}>{options.methods.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
            <label htmlFor="funding-amount">{selected?.amountUnit}{channel.provider === 'Sub2API' && selected?.currency ? `（${selected.currency}）` : ''}</label><input id="funding-amount" type="number" inputMode="decimal" min={selected?.min} max={selected?.max || 1000000} step={selected?.step} required value={amount} disabled={busy} placeholder={selected ? `最低 ${selected.min}` : ''} onChange={event => { setAmount(event.target.value); setQuote(null); setError('') }} />
            <small className="field-hint">按上游实际定价核算，本站余额显示用的充值倍率不会再次加到支付金额中。</small>
            {quote && <div className="funding-quote"><span>确认支付金额</span><strong>{money(quote.payable, quote.currency)}</strong>{!quote.currency && <small>上游未提供币种，请在收银台核对后付款。</small>}<small>仅创建充值订单，完成付款后才会到账。</small></div>}
            <button className="probe-button funding-primary" type="submit" disabled={busy || !amount || Number(amount) <= 0}>{busy ? '处理中…' : quote ? '确认创建充值订单' : '核算充值金额'}</button>
          </> : <p className="funding-description">暂未取得可用在线支付方式。</p>}
        </form>}
      </>}
      {result && <div className={`funding-result ${result.status}`} role="status">
        {result.status === 'success' && <CheckCircle size={22} />}<p>{result.message}</p>
        {result.order && <><dl><div><dt>订单</dt><dd>{result.order.id || '请在上游查看'}</dd></div><div><dt>支付金额</dt><dd>{result.order.payable == null ? '请在收银台核对' : money(result.order.payable, result.order.currency)}</dd></div><div><dt>状态</dt><dd>{orderLabels[result.order.status] || result.order.status || '待支付'}</dd></div></dl>
          {result.order.expiresAt && <small>支付截止：{new Date(result.order.expiresAt).toLocaleString('zh-CN', { hour12: false })}</small>}
          {orderPayable && result.order.qr && <div className="funding-qr"><QRCodeSVG value={result.order.qr} size={192} marginSize={4} title="上游支付二维码" /><span>使用对应支付应用扫码</span></div>}
          {result.order.notice && <p>{result.order.notice}</p>}
          {orderPayable && result.order.payUrl && <a className="funding-pay-link" href={result.order.payUrl} target="_blank" rel="noopener noreferrer">打开支付页面<ArrowSquareOut size={16} /></a>}
          <button type="button" className="outline-button" disabled={busy} onClick={() => run('status')}><ArrowsClockwise size={16} />{busy ? '查询中…' : result.order.id ? '查询订单并刷新余额' : '刷新账户余额'}</button>
        </>}
        {blockingResult && <button type="button" className="text-button funding-new" disabled={busy} onClick={resetResult}>{result.status === 'unknown' ? '已在上游核对，进行下一笔操作' : '进行下一笔操作'}</button>}
      </div>}
      <a className="funding-upstream" href={options.upstreamUrl} target="_blank" rel="noopener noreferrer">前往上游充值中心<ArrowSquareOut size={15} /></a>
    </>}
    {error && <p className="site-error" role="alert">{error}</p>}
    {!loading && !options && <button className="outline-button" onClick={() => setReload(value => value + 1)}>重新读取充值方式</button>}
  </dialog>
}

export default function ChannelFunding({ channel, disabled, onChanged }) {
  const [open, setOpen] = useState(false)
  return <><button type="button" className="funding-open" disabled={disabled} aria-label={`充值兑换 ${channel.name}`} onClick={() => setOpen(true)}>充值 / 兑换</button>{open && <FundingDialog channel={channel} onClose={() => setOpen(false)} onChanged={onChanged} />}</>
}
