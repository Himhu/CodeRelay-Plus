import { useEffect, useRef, useState } from 'react'
import { List, X } from '@phosphor-icons/react'


import { navigation as pages } from './route-navigation.js'

export default function MobileNavigation({ active }) {
  const [open, setOpen] = useState(false)
  const dialog = useRef(null)
  const opener = useRef(null)
  useEffect(() => { setOpen(false) }, [active])
  useEffect(() => {
    if (!open) return
    const element = dialog.current
    element.showModal()
    const desktop = matchMedia('(min-width: 761px)')
    const closeOnResize = () => { if (desktop.matches) setOpen(false) }
    desktop.addEventListener('change', closeOnResize)
    return () => { element.close(); desktop.removeEventListener('change', closeOnResize); opener.current?.focus({ preventScroll: true }) }
  }, [open])
  const navigate = id => { setOpen(false); window.location.hash = id }
  return <>
    <button ref={opener} type="button" className="mobile-menu-trigger" aria-label="打开导航" aria-expanded={open} aria-controls="mobile-navigation-menu" onClick={() => setOpen(true)}><List size={23}/></button>
    <nav className="mobile-navigation" aria-label="移动端主导航">{['overview', 'probes', 'secondary-channels', 'logs'].map(id => pages.find(page => page[0] === id)).filter(Boolean).map(([id, label, short, Icon]) =>
      <button key={id} type="button" aria-label={label} aria-current={active === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon size={21} weight={active === id ? 'fill' : 'regular'}/><span>{short}</span></button>)}</nav>
    {open && <dialog id="mobile-navigation-menu" ref={dialog} className="mobile-menu" aria-labelledby="mobile-menu-title" onCancel={event => { event.preventDefault(); setOpen(false) }} onClick={event => {
      const rect = event.currentTarget.getBoundingClientRect()
      if (event.target === event.currentTarget && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) setOpen(false)
    }}>
      <div className="mobile-menu-head"><h2 id="mobile-menu-title">导航</h2><button type="button" aria-label="关闭导航" onClick={() => setOpen(false)}><X size={22}/></button></div>
      <nav aria-label="全部页面">{pages.map(([id, label, , Icon]) => <button key={id} type="button" aria-current={active === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon size={21}/>{label}</button>)}</nav>
    </dialog>}
  </>
}
