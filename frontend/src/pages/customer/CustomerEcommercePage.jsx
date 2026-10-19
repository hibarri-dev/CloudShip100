import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  ShoppingBag,
  Plug,
  Calculator,
  Package,
  Code2,
  Copy,
  Check,
  Unplug,
  ExternalLink,
  BookOpen,
  MapPin,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { useToast } from '../../context/ToastContext'
import { isTestMode } from '../../services/mode'
import { portalService } from '../../services/portalService'
import { usePortalFetch } from '../../hooks/usePortalFetch'
import { PageHeader } from '../../components/ui/PageHeader'
import { Card } from '../../components/ui/Card'
import { FormField, formInputClass, SectionHeader } from '../../components/ui/FormField'
import { AddressPicker } from '../../components/ui/AddressPicker'
import { StatusBadge } from '../../components/ui/StatusBadge'
import { LoadingState, ErrorState } from '../../components/ui/LoadingState'
import { DataTable } from '../../components/ui/DataTable'
import { ShopCheckoutSettings } from './ShopCheckoutSettings'
import { StripePayModal } from './StripePayModal'
import { MarketplaceOrders } from './MarketplaceOrders'

const PLATFORMS = [
  {
    id: 'woocommerce',
    label: 'WooCommerce',
    hint: 'Install the CloudShip WordPress plugin. Sign in there to connect. Checkout shipping stays yours; courier prices show here after Place Order.',
    docsUrl: null,
    steps: [
      'Copy plugins/woocommerce-cloudship into wp-content/plugins and activate CloudShip.',
      'In WordPress go to WooCommerce → CloudShip.',
      'Enter your CloudShip API URL (no /v1), seller email, and password, then click Connect store.',
      'The plugin creates REST keys and the Order created webhook. You do not paste a Connection ID.',
      'Place a test order on the shop. It appears under Orders in this CloudShip page.',
    ],
    fieldsNeeded: 'Optional manual connect: Store URL + Consumer key + Consumer secret',
  },
  {
    id: 'shopify',
    label: 'Shopify',
    hint: 'Connect via Custom App Admin API or Webhook Notifications.',
    docsUrl: 'https://partners.shopify.com',
    steps: [
      'Shopify Admin → Settings → Apps & sales channels → Develop apps → Create an app.',
      'Configure Admin API scopes: read_orders, write_orders, read_shipping, write_shipping, write_fulfillments.',
      'Click Save → Install App → Reveal Admin API access token (shpat_…).',
      'Paste shop domain (mystore.myshopify.com) + access token below and click Connect.',
      'Go to Shopify Admin → Settings → Notifications → Webhooks → Create Webhook.',
      'Event: Order creation | Format: JSON | URL: https://<NGROK_OR_DOMAIN>/v1/webhooks/shopify/orders?connectionId=<CONNECTION_ID>',
    ],
    fieldsNeeded: 'Shop domain + Access token (shpat_…)',
  },
  {
    id: 'wix',
    label: 'Wix',
    hint: 'Connect via Wix Dev Center App & Extensions.',
    docsUrl: 'https://dev.wix.com',
    steps: [
      'Wix Dev Center → Create App → Grant Permissions: Orders (Read), eCommerce Fulfillments (Read/Write), Shipping Rates (Read/Write).',
      'In Wix Dev App → Webhooks → Add Webhook → Wix Stores → Order Created.',
      'Callback URL: https://<NGROK_OR_DOMAIN>/v1/webhooks/wix/orders?connectionId=<CONNECTION_ID>',
      'In Wix Dev App → Extensions → Ecom Shipping Rates → Set Base URI: https://<NGROK_OR_DOMAIN>/v1/webhooks/wix/rates?connectionId=<CONNECTION_ID>',
      'Install app on your dev site, then paste the access token below to connect.',
    ],
    fieldsNeeded: 'Access token',
  },
  {
    id: 'lovable',
    label: 'Lovable / Universal',
    hint: 'No external keys required. CloudShip generates a Public API Key upon connection.',
    docsUrl: null,
    steps: [
      'Enter a store name below and click Connect.',
      'Copy your generated publicApiKey (cs_live_…) and webhookSecret (shown once).',
      'Set VITE_CLOUDSHIP_API_KEY=cs_live_... and VITE_CLOUDSHIP_API_URL=https://<NGROK_OR_DOMAIN> in your .env file.',
      'In your Lovable site: POST /v1/webhooks/lovable/rates (for checkout quotes) & POST /v1/webhooks/lovable/orders (for order placement).',
      'Pass header: x-cloudship-key: <YOUR_PUBLIC_API_KEY>.',
    ],
    fieldsNeeded: 'Store name only'
  },
  {
    id: 'bigcommerce',
    label: 'BigCommerce',
    hint: 'Custom API connection: store hash + access token. No App Marketplace listing required.',
    docsUrl: 'https://partners.bigcommerce.com',
    steps: [
      'Sign up at BigCommerce Partners and create a trial / sandbox store (free).',
      'Store API accounts → Create API account. Scopes: Orders (read), Information & settings as needed.',
      'Copy the store hash and access token, then paste them below and click Connect.',
      'Optional: paste the webhook / client secret so CloudShip can verify HMAC on live stores.',
      'After connect, copy Connection ID from Connected stores.',
      'Settings → Webhooks (or API): store/order/created → https://<NGROK_OR_DOMAIN>/v1/webhooks/bigcommerce/orders?connectionId=<CONNECTION_ID>',
      'Place a test order. Confirm it under E-commerce → Shop orders.',
      'Rates callback (optional): POST Shipping Provider JSON to https://<NGROK_OR_DOMAIN>/v1/webhooks/bigcommerce/rates?connectionId=<CONNECTION_ID>. Checkout live rates need a draft shipping-provider app pointed at that URL.',
    ],
    fieldsNeeded: 'Store hash + Access token (optional client secret for HMAC)',
  },
]

const TAB_IDS = ['connect', 'stores', 'rules', 'quotes', 'orders', 'tracking']

const NAV_GROUPS = [
  {
    group: 'Integrations',
    items: [
      { id: 'connect', label: 'Connect a store', icon: Plug, hint: 'Woo, Shopify, Wix, BigCommerce, Lovable' },
      { id: 'stores', label: 'Connected stores', icon: ShoppingBag, hint: 'Keys and connection IDs' },
      { id: 'rules', label: 'Checkout rules', icon: MapPin, hint: 'Pickup, margin, table rates' },
      { id: 'quotes', label: 'Test rates', icon: Calculator, hint: 'Try a quote before go-live' },
    ],
  },
  {
    group: 'Orders',
    items: [
      { id: 'orders', label: 'Shop orders', icon: Package, hint: 'Pay and book couriers' },
    ],
  },
  {
    group: 'Tracking',
    items: [
      { id: 'tracking', label: 'Widget & shortcode', icon: Code2, hint: 'Embed tracking on your shop' },
    ],
  },
]

function fillGuideStep(step, apiOrigin) {
  const base = String(apiOrigin || '').replace(/\/$/, '')
  return String(step)
    .replaceAll('https://<NGROK_OR_DOMAIN>', base)
    .replaceAll('<NGROK_OR_DOMAIN>', base.replace(/^https?:\/\//, ''))
}

function PlatformKeyGuide({ platform, apiOrigin, onCopy, copiedKey }) {
  if (!platform) return null
  const base = String(apiOrigin || '').replace(/\/$/, '')
  const isLocal = /localhost|127\.0\.0\.1/i.test(base)

  return (
    <div className="mb-5 rounded-xl border border-sky-200 bg-sky-50/80 p-4 text-sm text-sky-950">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <BookOpen size={16} className="text-sky-700" />
        <p className="font-extrabold text-ink">Where to get your keys — {platform.label}</p>
        {platform.docsUrl ? (
          <a
            href={platform.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs font-semibold text-brand underline"
          >
            Open site <ExternalLink size={12} />
          </a>
        ) : null}
      </div>
      <p className="mb-2 text-xs text-muted">{platform.hint}</p>

      <div className="mb-3 rounded-lg border border-brand/20 bg-white p-3">
        <p className="text-[11px] font-bold uppercase tracking-wide text-muted">Your CloudShip backend URL</p>
        <p className="mt-1 break-all font-mono text-xs font-semibold text-ink">{base || '—'}</p>
        <p className="mt-1 text-[11px] text-muted">
          Put this in Woo / Shopify / Wix / BigCommerce / Lovable where it asks for CloudShip API or webhook host.
          {isLocal
            ? ' Local only — for real shops use your deployed URL (or ngrok while testing).'
            : ' This is your live/staging API — customers use this, not localhost.'}
        </p>
        <button
          type="button"
          className={`${btnGhost} mt-2`}
          onClick={() => onCopy?.('api-origin', base)}
        >
          {copiedKey === 'api-origin' ? <Check size={12} /> : <Copy size={12} />} Copy backend URL
        </button>
      </div>

      <p className="mb-2 text-xs font-bold uppercase tracking-wide text-sky-800">
        You will paste: {platform.fieldsNeeded}
      </p>
      <ol className="list-decimal space-y-1.5 pl-5 text-xs leading-relaxed text-ink">
        {platform.steps.map((step) => (
          <li key={step}>{fillGuideStep(step, base)}</li>
        ))}
      </ol>
      <p className="mt-3 text-[11px] font-semibold text-amber-800">
        Tip: After you connect, open Connected stores and copy the full webhook URL (includes your connection ID).
        Shop keys go in this form only — not in CloudShip .env.
      </p>
    </div>
  )
}

const emptyForm = {
  platform: 'woocommerce',
  storeName: '',
  storeUrl: '',
  currency: 'ZAR',
  consumerKey: '',
  consumerSecret: '',
  shopDomain: '',
  accessToken: '',
}

const btnPrimary =
  'inline-flex items-center justify-center gap-2 rounded-full bg-brand-gradient px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:brightness-105 disabled:opacity-50'
const btnGhost =
  'inline-flex items-center justify-center gap-2 rounded-full border border-line bg-white px-3 py-1.5 text-xs font-semibold text-ink hover:bg-surface disabled:opacity-50'

function buildCredentials(form) {
  if (form.platform === 'woocommerce') {
    return {
      consumerKey: form.consumerKey.trim(),
      consumerSecret: form.consumerSecret.trim(),
      storeUrl: form.storeUrl.trim(),
    }
  }
  if (form.platform === 'shopify') {
    return {
      shopDomain: form.shopDomain.trim() || form.storeUrl.trim(),
      accessToken: form.accessToken.trim(),
    }
  }
  if (form.platform === 'wix') {
    return {
      accessToken: form.accessToken.trim(),
    }
  }
  if (form.platform === 'bigcommerce') {
    return {
      storeHash: form.shopDomain.trim() || form.storeUrl.trim(),
      accessToken: form.accessToken.trim(),
      clientSecret: form.consumerSecret.trim() || undefined,
    }
  }
  return {}
}

function panelTitle(tab) {
  const item = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.id === tab)
  return item || { label: 'E-commerce', hint: '' }
}

export default function CustomerEcommercePage() {
  const { tokens } = useAuth()
  const toast = useToast()
  const token = tokens?.access?.token
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedTab = searchParams.get('tab')
  const tab = TAB_IDS.includes(requestedTab) ? requestedTab : 'connect'

  const {
    data: stores,
    loading: storesLoading,
    error: storesError,
    refetch: refetchStores,
  } = usePortalFetch(portalService.listEcommerceStores)

  const {
    data: bookings,
    loading: bookingsLoading,
    error: bookingsError,
    refetch: refetchBookings,
  } = usePortalFetch(portalService.getMyBookings)

  const [form, setForm] = useState(emptyForm)
  const [connecting, setConnecting] = useState(false)
  const [lastConnected, setLastConnected] = useState(null)

  const [quoteForm, setQuoteForm] = useState({
    connectionId: '',
    pickup: 'Cape Town',
    dropoff: 'Johannesburg',
    weightKg: '2',
  })
  const [quoteResult, setQuoteResult] = useState(null)
  const [quoting, setQuoting] = useState(false)

  const [payingId, setPayingId] = useState(null)
  const [payingQuoteId, setPayingQuoteId] = useState(null)
  const payingLock = useRef(false)
  const [copied, setCopied] = useState('')
  const [payConfig, setPayConfig] = useState({ mode: 'mock', ready: true, publishableKey: '' })
  const [stripeCheckout, setStripeCheckout] = useState(null)
  const [navCollapsed, setNavCollapsed] = useState(false)

  const setTab = (next) => {
    const params = new URLSearchParams(searchParams)
    params.set('tab', next)
    setSearchParams(params, { replace: true })
  }

  useEffect(() => {
    if (!token) return undefined
    portalService.getPaymentConfig(token).then(setPayConfig).catch(() => {})
    const params = new URLSearchParams(window.location.search)
    const intent = params.get('payment_intent')
    if (!intent) return undefined
    let cancelled = false
    setTab('orders')
    portalService
      .confirmMarketplacePayment(token, intent)
      .then(() => {
        if (cancelled) return
        toast.success('Card paid. Courier booked. We emailed the shop and the buyer.')
        refetchBookings()
        window.history.replaceState({}, '', `${window.location.pathname}?tab=orders`)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [token])

  const storeList = useMemo(() => {
    const rows = stores || []
    if (lastConnected?.id && !rows.some((s) => s.id === lastConnected.id)) {
      return [lastConnected, ...rows]
    }
    return rows
  }, [stores, lastConnected])
  const marketplaceBookings = useMemo(
    () =>
      (bookings || []).filter((b) =>
        ['woocommerce', 'shopify', 'wix', 'lovable', 'bigcommerce'].includes(b.source)
      ),
    [bookings]
  )

  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const sampleCode = marketplaceBookings[0]?.code || 'BKG-MKT-00001'
  const iframeSnippet = `<iframe src="${origin}/embed/track?code=${sampleCode}" width="100%" height="220" style="border:0;border-radius:12px" title="CloudShip tracking"></iframe>`
  const shortcodeSnippet = `[cloudship_track code="${sampleCode}"]`
  const activeStoreCount = storeList.filter((s) => s.status === 'active').length
  const current = panelTitle(tab)

  const setField = (key, value) => setForm((prev) => ({ ...prev, [key]: value }))

  const connectStore = async (e) => {
    e.preventDefault()
    if (!form.storeName.trim()) {
      toast.error('Store name is required')
      return
    }
    setConnecting(true)
    try {
      const body = {
        platform: form.platform,
        storeName: form.storeName.trim(),
        storeUrl:
          form.platform === 'shopify' || form.platform === 'bigcommerce'
            ? form.shopDomain.trim() || form.storeUrl.trim()
            : form.storeUrl.trim(),
        credentials: buildCredentials(form),
        settings: {
          currency: form.currency.trim() || 'ZAR',
          defaultMode: 'Road',
        },
      }
      const created = await portalService.connectEcommerceStore(token, body)
      setLastConnected(created)
      setForm({ ...emptyForm, platform: form.platform })
      refetchStores()
      setTab('rules')
      toast.success(`${created.platform} store connected. Add pickup warehouses in Checkout rules.`)
    } catch (err) {
      toast.error(err.message || 'Failed to connect store')
    } finally {
      setConnecting(false)
    }
  }

  const disconnect = async (connectionId) => {
    try {
      await portalService.disconnectEcommerceStore(token, connectionId)
      toast.success('Store disconnected')
      refetchStores()
    } catch (err) {
      toast.error(err.message || 'Disconnect failed')
    }
  }

  const runQuote = async (e) => {
    e.preventDefault()
    setQuoting(true)
    setQuoteResult(null)
    try {
      const result = await portalService.createMarketplaceQuote(token, {
        connectionId: quoteForm.connectionId || undefined,
        pickup: quoteForm.pickup.trim(),
        dropoff: quoteForm.dropoff.trim(),
        weightKg: Number(quoteForm.weightKg),
        currency: 'ZAR',
        mode: 'Road',
      })
      setQuoteResult(result)
      toast.success('Live marketplace quote ready')
    } catch (err) {
      toast.error(err.message || 'Quote failed')
    } finally {
      setQuoting(false)
    }
  }

  const clearPaying = () => {
    payingLock.current = false
    setPayingId(null)
    setPayingQuoteId(null)
  }

  const confirmPay = async (booking, selection) => {
    if (payingLock.current) return
    payingLock.current = true
    const { quoteKey, ...paymentSelection } = selection
    setPayingId(booking.id)
    setPayingQuoteId(quoteKey || `${selection.partner}::${selection.service}`)
    let openedStripe = false
    try {
      const payment = await portalService.createMarketplacePayment(token, booking.id, paymentSelection)
      if (payment.mode === 'stripe') {
        if (payment.status === 'paid') {
          await portalService.confirmMarketplacePayment(token, payment.paymentIntentId)
          toast.success('Payment confirmed. Courier booked. We emailed the shop and the buyer.')
          refetchBookings()
          return
        }
        if (!payment.clientSecret || !(payment.publishableKey || payConfig.publishableKey)) {
          toast.error('Stripe is on but STRIPE_SECRET_KEY or STRIPE_PUBLISHABLE_KEY is missing')
          return
        }
        setStripeCheckout({
          paymentIntentId: payment.paymentIntentId,
          clientSecret: payment.clientSecret,
          publishableKey: payment.publishableKey || payConfig.publishableKey,
          amount: payment.amount,
          currency: payment.currency,
        })
        openedStripe = true
        return
      }
      await portalService.confirmMarketplacePayment(token, payment.paymentIntentId)
      toast.success('Payment confirmed. Courier booked. We emailed the shop and the buyer.')
      refetchBookings()
    } catch (err) {
      toast.error(err.message || 'Payment confirm failed')
    } finally {
      if (!openedStripe) clearPaying()
    }
  }

  const finishStripePay = async () => {
    const intent = stripeCheckout?.paymentIntentId
    if (!intent) return
    try {
      await portalService.confirmMarketplacePayment(token, intent)
      toast.success('Card paid. Courier booked. We emailed the shop and the buyer.')
      refetchBookings()
      setStripeCheckout(null)
      clearPaying()
    } catch (err) {
      const message = err.message || 'Paid but the courier book failed. Refresh or retry.'
      toast.error(message)
      throw err
    }
  }

  const retryCourierBook = async (booking) => {
    if (payingLock.current) return
    if (!booking?.paymentIntentId) {
      toast.error('No payment intent on this order — cannot retry book')
      return
    }
    payingLock.current = true
    setPayingId(booking.id)
    setPayingQuoteId('retry-book')
    try {
      await portalService.confirmMarketplacePayment(token, booking.paymentIntentId)
      toast.success('Courier booked. Tracking updated.')
      refetchBookings()
    } catch (err) {
      toast.error(err.message || 'Courier book retry failed')
    } finally {
      clearPaying()
    }
  }

  const copyText = async (key, text) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      toast.success('Copied')
      setTimeout(() => setCopied(''), 1500)
    } catch {
      toast.error('Copy failed — select and copy manually')
    }
  }

  if (storesLoading || bookingsLoading) {
    return <LoadingState label="Loading e-commerce workspace..." />
  }
  if (storesError) return <ErrorState message={storesError} />
  if (bookingsError) return <ErrorState message={bookingsError} />

  const badgeFor = (id) => {
    if (id === 'stores') return storeList.length
    if (id === 'orders') return marketplaceBookings.length
    return null
  }

  return (
    <div>
      <PageHeader
        title="E-commerce"
        subtitle="Connect a shop, then handle orders and tracking from the menu on the left."
      />

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <aside className={`w-full shrink-0 transition-[width] duration-200 ${navCollapsed ? 'lg:w-16' : 'lg:w-[30%]'}`}>
          <Card className="p-3 lg:sticky lg:top-4">
            <div className="mb-1 hidden items-center lg:flex">
              <button
                type="button"
                onClick={() => setNavCollapsed((open) => !open)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface hover:text-ink"
                aria-label={navCollapsed ? 'Expand menu' : 'Collapse menu'}
                title={navCollapsed ? 'Expand menu' : 'Collapse menu'}
              >
                {navCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
              </button>
              {!navCollapsed ? (
                <span className="text-xs font-semibold text-muted">Menu</span>
              ) : null}
            </div>
            <nav className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0" aria-label="E-commerce sections">
              {NAV_GROUPS.map((group) => (
                <div key={group.group} className="min-w-max lg:min-w-0">
                  {!navCollapsed ? (
                    <p className="mb-1.5 px-3 pt-2 text-[11px] font-bold uppercase tracking-wide text-muted">
                      {group.group}
                    </p>
                  ) : (
                    <div className="hidden lg:block lg:my-1 lg:border-t lg:border-line" />
                  )}
                  <div className="flex gap-1 lg:flex-col">
                    {group.items.map((item) => {
                      const Icon = item.icon
                      const active = tab === item.id
                      const count = badgeFor(item.id)
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => setTab(item.id)}
                          title={item.label}
                          className={`flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition ${
                            navCollapsed ? 'lg:items-center lg:justify-center lg:px-2' : ''
                          } ${
                            active ? 'bg-brand-light text-ink shadow-sm' : 'text-muted hover:bg-surface hover:text-ink'
                          }`}
                        >
                          <span className="relative shrink-0">
                            <Icon size={16} className={`mt-0.5 ${active ? 'text-brand' : ''} ${navCollapsed ? 'lg:mt-0' : ''}`} />
                            {navCollapsed && count != null ? (
                              <span className="absolute -right-1.5 -top-1 hidden h-3.5 min-w-3.5 rounded-full bg-brand px-0.5 text-center text-[9px] font-bold leading-[14px] text-white lg:block">
                                {count}
                              </span>
                            ) : null}
                          </span>
                          <span className={`min-w-0 flex-1 ${navCollapsed ? 'lg:hidden' : ''}`}>
                            <span className="flex items-center justify-between gap-2">
                              <span className="text-sm font-semibold">{item.label}</span>
                              {count != null ? (
                                <span
                                  className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                                    active ? 'bg-white text-brand' : 'bg-surface text-muted'
                                  }`}
                                >
                                  {count}
                                </span>
                              ) : null}
                            </span>
                            <span className="mt-0.5 hidden text-[11px] leading-snug lg:block">{item.hint}</span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </nav>
          </Card>
        </aside>

        <section className={`min-w-0 w-full ${navCollapsed ? 'lg:flex-1' : 'lg:w-[70%]'}`}>
          {tab === 'connect' ? (
            <Card className="p-5">
              <SectionHeader
                icon={Plug}
                title={current.label}
                description="Pick a platform — we show exactly where to copy keys from. Paste them here (not in .env)."
              />
              <PlatformKeyGuide
                platform={PLATFORMS.find((p) => p.id === form.platform)}
                apiOrigin={portalService.apiOrigin}
                onCopy={copyText}
                copiedKey={copied}
              />
              <form onSubmit={connectStore} className="grid gap-4 md:grid-cols-2">
                <FormField id="platform" label="Platform" required>
                  <select
                    id="platform"
                    className={formInputClass()}
                    value={form.platform}
                    onChange={(e) => setField('platform', e.target.value)}
                  >
                    {PLATFORMS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </FormField>
                <FormField id="storeName" label="Store name" required>
                  <input
                    id="storeName"
                    className={formInputClass()}
                    value={form.storeName}
                    onChange={(e) => setField('storeName', e.target.value)}
                    placeholder="My Woo Shop"
                  />
                </FormField>

                {isTestMode() ? (
                  <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    {form.platform === 'lovable'
                      ? 'You are in Test mode: this store gets a cs_test_ key and uses simulated carriers. Nothing is booked, charged or invoiced, and it stays out of Live mode. Switch to Live (top right) for a real store.'
                      : 'Test mode supports Lovable / Universal stores only. Switch to Live (top right) to connect this platform.'}
                  </p>
                ) : null}

                {form.platform !== 'lovable' ? (
                  <FormField
                    id="storeUrl"
                    label={
                      form.platform === 'shopify'
                        ? 'Shop domain / URL'
                        : form.platform === 'bigcommerce'
                          ? 'Store hash'
                          : 'Store URL'
                    }
                    hint={
                      form.platform === 'woocommerce'
                        ? 'e.g. http://cloudship-logistics.local'
                        : form.platform === 'bigcommerce'
                          ? 'From Store API account — e.g. abc123xyz'
                          : 'e.g. mystore.myshopify.com'
                    }
                  >
                    <input
                      id="storeUrl"
                      className={formInputClass()}
                      value={
                        form.platform === 'shopify' || form.platform === 'bigcommerce'
                          ? form.shopDomain || form.storeUrl
                          : form.storeUrl
                      }
                      onChange={(e) => {
                        if (form.platform === 'shopify' || form.platform === 'bigcommerce') {
                          setField('shopDomain', e.target.value)
                        } else setField('storeUrl', e.target.value)
                      }}
                    />
                  </FormField>
                ) : null}

                {form.platform === 'woocommerce' ? (
                  <>
                    <FormField id="consumerKey" label="Consumer key (ck_…)" required>
                      <input
                        id="consumerKey"
                        className={formInputClass()}
                        value={form.consumerKey}
                        onChange={(e) => setField('consumerKey', e.target.value)}
                        autoComplete="off"
                      />
                    </FormField>
                    <FormField id="consumerSecret" label="Consumer secret (cs_…)" required>
                      <input
                        id="consumerSecret"
                        type="password"
                        className={formInputClass()}
                        value={form.consumerSecret}
                        onChange={(e) => setField('consumerSecret', e.target.value)}
                        autoComplete="off"
                      />
                    </FormField>
                  </>
                ) : null}

                {form.platform === 'shopify' || form.platform === 'wix' || form.platform === 'bigcommerce' ? (
                  <FormField
                    id="accessToken"
                    label={
                      form.platform === 'shopify'
                        ? 'Admin API access token (shpat_…)'
                        : form.platform === 'bigcommerce'
                          ? 'Store API access token'
                          : 'Wix access token'
                    }
                    required
                    hint={
                      form.platform === 'shopify'
                        ? 'From Develop apps → API credentials → Reveal token'
                        : form.platform === 'bigcommerce'
                          ? 'From Settings → API accounts → Create API account'
                          : 'From Wix Dev Center app credentials'
                    }
                  >
                    <input
                      id="accessToken"
                      type="password"
                      className={formInputClass()}
                      value={form.accessToken}
                      onChange={(e) => setField('accessToken', e.target.value)}
                      autoComplete="off"
                      placeholder={form.platform === 'shopify' ? 'shpat_…' : 'Access token'}
                    />
                  </FormField>
                ) : null}

                {form.platform === 'bigcommerce' ? (
                  <FormField
                    id="clientSecret"
                    label="Client / webhook secret (optional)"
                    hint="Used to verify X-Signature HMAC. Leave blank while testing with ngrok."
                  >
                    <input
                      id="clientSecret"
                      type="password"
                      className={formInputClass()}
                      value={form.consumerSecret}
                      onChange={(e) => setField('consumerSecret', e.target.value)}
                      autoComplete="off"
                    />
                  </FormField>
                ) : null}

                <div className="md:col-span-2">
                  <p className="mb-3 text-xs text-muted">
                    Add warehouses in{' '}
                    <button type="button" className="font-semibold text-brand underline" onClick={() => setTab('rules')}>
                      Checkout rules
                    </button>{' '}
                    after you connect — including extra pickup points and closest-to-customer.
                  </p>
                  <button type="submit" className={btnPrimary} disabled={connecting}>
                    {connecting ? 'Connecting…' : 'Connect store'}
                  </button>
                </div>
              </form>
            </Card>
          ) : null}

          {tab === 'stores' ? (
            <Card className="p-5">
              <SectionHeader
                icon={ShoppingBag}
                title={current.label}
                description="Each store is a CloudShip connection. Keys stay encrypted on the server — never in .env."
              />
              {storeList.length === 0 ? (
                <p className="text-sm text-muted">
                  No stores yet.{' '}
                  <button type="button" className="font-semibold text-brand underline" onClick={() => setTab('connect')}>
                    Connect a store
                  </button>
                </p>
              ) : (
                <DataTable
                  columns={[
                    { key: 'storeName', label: 'Store' },
                    { key: 'platform', label: 'Platform', render: (row) => row.platform },
                    {
                      key: 'storeUrl',
                      label: 'URL',
                      render: (row) => row.storeUrl || '—',
                    },
                    {
                      key: 'status',
                      label: 'Status',
                      render: (row) => <StatusBadge status={row.status} />,
                    },
                    {
                      key: 'id',
                      label: 'Connection ID',
                      render: (row) => (
                        <button type="button" className={btnGhost} onClick={() => copyText(`id-${row.id}`, row.id)}>
                          {copied === `id-${row.id}` ? <Check size={12} /> : <Copy size={12} />}
                          <span className="max-w-[120px] truncate font-mono text-[10px]">{row.id}</span>
                        </button>
                      ),
                    },
                    {
                      key: 'action',
                      label: '',
                      render: (row) =>
                        row.status === 'active' ? (
                          <button type="button" className={btnGhost} onClick={() => disconnect(row.id)}>
                            <Unplug size={12} /> Disconnect
                          </button>
                        ) : null,
                    },
                  ]}
                  rows={storeList}
                />
              )}

              {storeList.filter((s) => s.status === 'active').length > 0 ? (
                <div className="mt-4 space-y-3">
                  <p className="text-xs font-bold uppercase tracking-wide text-muted">
                    Webhook URLs for your shops (copy into Shopify / Wix / BigCommerce / Lovable)
                  </p>
                  {storeList
                    .filter((s) => s.status === 'active')
                    .map((s) => {
                      const base = String(portalService.apiOrigin || '').replace(/\/$/, '')
                      const ordersUrl = `${base}/v1/webhooks/${s.platform}/orders/${s.id}`
                      const ratesUrl = `${base}/v1/webhooks/${s.platform}/rates/${s.id}`
                      return (
                        <div key={s.id} className="rounded-xl border border-line bg-surface p-3 text-xs">
                          <p className="font-extrabold text-ink">
                            {s.storeName} <span className="font-normal text-muted">({s.platform})</span>
                            {s.livemode === false ? (
                              <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">Test</span>
                            ) : null}
                          </p>
                          <div className="mt-2 space-y-2">
                            <div className="flex flex-wrap items-start gap-2">
                              <span className="shrink-0 font-semibold text-muted">Orders</span>
                              <code className="min-w-0 flex-1 break-all rounded bg-white px-2 py-1 font-mono text-[10px]">
                                {ordersUrl}
                              </code>
                              <button
                                type="button"
                                className={btnGhost}
                                onClick={() => copyText(`wh-o-${s.id}`, ordersUrl)}
                              >
                                {copied === `wh-o-${s.id}` ? <Check size={12} /> : <Copy size={12} />}
                              </button>
                            </div>
                            <div className="flex flex-wrap items-start gap-2">
                              <span className="shrink-0 font-semibold text-muted">Rates</span>
                              <code className="min-w-0 flex-1 break-all rounded bg-white px-2 py-1 font-mono text-[10px]">
                                {ratesUrl}
                              </code>
                              <button
                                type="button"
                                className={btnGhost}
                                onClick={() => copyText(`wh-r-${s.id}`, ratesUrl)}
                              >
                                {copied === `wh-r-${s.id}` ? <Check size={12} /> : <Copy size={12} />}
                              </button>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                </div>
              ) : null}

              {lastConnected?.webhookSecret || lastConnected?.publicApiKey ? (
                <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
                  <p className="font-bold">Save these now (shown once after connect)</p>
                  {lastConnected.webhookSecret ? (
                    <p className="mt-2 font-mono text-xs">webhookSecret: {lastConnected.webhookSecret}</p>
                  ) : null}
                  {lastConnected.publicApiKey ? (
                    <p className="mt-1 font-mono text-xs">publicApiKey: {lastConnected.publicApiKey}</p>
                  ) : null}
                </div>
              ) : null}
            </Card>
          ) : null}

          {tab === 'rules' ? (
            activeStoreCount === 0 ? (
              <Card className="p-5">
                <SectionHeader
                  icon={MapPin}
                  title={current.label}
                  description="Pickup points, extra margin, and table rates — after a store is connected."
                />
                <p className="text-sm text-muted">
                  Connect a store first, then set pickup and pricing rules here.{' '}
                  <button type="button" className="font-semibold text-brand underline" onClick={() => setTab('connect')}>
                    Connect a store
                  </button>
                </p>
              </Card>
            ) : (
              <ShopCheckoutSettings
                stores={storeList}
                token={token}
                toast={toast}
                onSaved={refetchStores}
                preferredStoreId={lastConnected?.id}
              />
            )
          ) : null}

          {tab === 'quotes' ? (
            <Card className="p-5">
              <SectionHeader
                icon={Calculator}
                title={current.label}
                description="Live courier price + CloudShip 10% + your extra %. Table rates show when they match."
              />
              <form onSubmit={runQuote} className="grid gap-4 md:grid-cols-2">
                <FormField id="connectionId" label="Store (optional)">
                  <select
                    id="connectionId"
                    className={formInputClass()}
                    value={quoteForm.connectionId}
                    onChange={(e) => setQuoteForm((p) => ({ ...p, connectionId: e.target.value }))}
                  >
                    <option value="">None</option>
                    {storeList
                      .filter((s) => s.status === 'active')
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.storeName} ({s.platform}{s.livemode === false ? ', test' : ''})
                        </option>
                      ))}
                  </select>
                </FormField>
                <FormField id="weightKg" label="Weight (kg)" required>
                  <input
                    id="weightKg"
                    type="number"
                    min="0.1"
                    step="0.1"
                    className={formInputClass()}
                    value={quoteForm.weightKg}
                    onChange={(e) => setQuoteForm((p) => ({ ...p, weightKg: e.target.value }))}
                  />
                </FormField>
                <FormField id="pickup" label="Pickup" required>
                  <AddressPicker
                    id="pickup"
                    required
                    value={quoteForm.pickup}
                    onChange={(next) => setQuoteForm((p) => ({ ...p, pickup: next }))}
                    placeholder="Search street, city, postal code, country"
                    className={formInputClass()}
                  />
                </FormField>
                <FormField id="dropoff" label="Dropoff" required>
                  <AddressPicker
                    id="dropoff"
                    required
                    value={quoteForm.dropoff}
                    onChange={(next) => setQuoteForm((p) => ({ ...p, dropoff: next }))}
                    placeholder="Search street, city, postal code, country"
                    className={formInputClass()}
                  />
                </FormField>
                <div className="md:col-span-2">
                  <button type="submit" className={btnPrimary} disabled={quoting}>
                    {quoting ? 'Getting rates…' : 'Get live quote'}
                  </button>
                </div>
              </form>

              {quoteResult ? (
                <div className="mt-5 overflow-x-auto rounded-xl border border-line">
                  <table className="min-w-full text-left text-sm">
                    <thead className="bg-surface text-xs uppercase text-muted">
                      <tr>
                        <th className="px-3 py-2">Partner</th>
                        <th className="px-3 py-2">Carrier</th>
                        <th className="px-3 py-2">CloudShip</th>
                        <th className="px-3 py-2">Your cut</th>
                        <th className="px-3 py-2">Customer pays</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(quoteResult.options || []).map((opt) => (
                        <tr key={`${opt.partner}-${opt.service}`} className="border-t border-line">
                          <td className="px-3 py-2 font-semibold text-ink">
                            {opt.partner} / {opt.service}
                          </td>
                          <td className="px-3 py-2">R {opt.carrierCost}</td>
                          <td className="px-3 py-2">R {opt.marginAmount}</td>
                          <td className="px-3 py-2">R {opt.shopMarginAmount || 0}</td>
                          <td className="px-3 py-2 font-bold text-brand">R {opt.quotedPrice}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="border-t border-line bg-surface px-3 py-2 font-mono text-[11px] text-muted">
                    quoteId: {quoteResult.quoteId} · selected R {quoteResult.selected?.quotedPrice}
                  </p>
                </div>
              ) : null}
            </Card>
          ) : null}

          {tab === 'orders' ? (
            <Card className="p-5">
              <SectionHeader
                icon={Package}
                title={current.label}
                description="Orders from connected shops. Open a row to see live courier rates, pick one, then pay."
              />
              {payConfig.mode === 'stripe' && !payConfig.ready ? (
                <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  PAYMENT_MODE is stripe. Paste STRIPE_SECRET_KEY (sk_test_…) and STRIPE_PUBLISHABLE_KEY (pk_test_…) in
                  backend .env, then restart the backend. Use test card 4242 4242 4242 4242.
                </p>
              ) : null}
              {marketplaceBookings.length === 0 ? (
                <p className="text-sm text-muted">
                  No shop orders yet. Connect a store, add the Woo webhook, then place a test order.
                </p>
              ) : (
                <MarketplaceOrders
                  rows={marketplaceBookings}
                  stores={storeList}
                  token={token}
                  payingId={payingId}
                  payingQuoteId={payingQuoteId}
                  payConfig={payConfig}
                  payLabel={
                    payConfig.mode === 'stripe'
                      ? payConfig.ready
                        ? 'Pay'
                        : 'Stripe keys missing'
                      : 'Mock pay & book'
                  }
                  onPay={confirmPay}
                  onRetryBook={retryCourierBook}
                />
              )}
            </Card>
          ) : null}

          {tab === 'tracking' ? (
            <Card className="p-5">
              <SectionHeader
                icon={Code2}
                title={current.label}
                description="Paste the tracking shortcode on a thank-you page. Checkout rates come from the connected shop, not this snippet."
              />
              <div className="space-y-4">
                <div>
                  <p className="mb-1 text-xs font-bold uppercase text-muted">WordPress-style shortcode</p>
                  <pre className="overflow-x-auto rounded-xl bg-ink p-3 font-mono text-xs text-white">
                    {shortcodeSnippet}
                  </pre>
                  <button type="button" className={`${btnGhost} mt-2`} onClick={() => copyText('sc', shortcodeSnippet)}>
                    {copied === 'sc' ? <Check size={12} /> : <Copy size={12} />} Copy shortcode
                  </button>
                </div>
                <div>
                  <p className="mb-1 text-xs font-bold uppercase text-muted">HTML iframe embed</p>
                  <pre className="overflow-x-auto rounded-xl bg-ink p-3 font-mono text-xs text-white">
                    {iframeSnippet}
                  </pre>
                  <button type="button" className={`${btnGhost} mt-2`} onClick={() => copyText('iframe', iframeSnippet)}>
                    {copied === 'iframe' ? <Check size={12} /> : <Copy size={12} />} Copy iframe
                  </button>
                </div>
                <p className="text-sm text-muted">
                  Preview widget:{' '}
                  <a
                    className="font-semibold text-brand underline"
                    href={`/embed/track?code=${sampleCode}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    /embed/track?code={sampleCode}
                  </a>
                </p>
              </div>
            </Card>
          ) : null}
        </section>
      </div>

      {stripeCheckout ? (
        <StripePayModal
          clientSecret={stripeCheckout.clientSecret}
          publishableKey={stripeCheckout.publishableKey}
          amount={stripeCheckout.amount}
          currency={stripeCheckout.currency}
          onClose={() => {
            setStripeCheckout(null)
            clearPaying()
          }}
          onPaid={finishStripePay}
        />
      ) : null}
    </div>
  )
}
