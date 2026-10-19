import { modeHeaders } from './mode'

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/v1'
const API_ORIGIN = API_BASE_URL.replace(/\/v1$/, '')

async function request(path, { token, method = 'GET', body } = {}) {
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: {
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...modeHeaders(),
    },
    body: body ? (isFormData ? body : JSON.stringify(body)) : undefined,
  })
  if (res.status === 204) return null
  const data = await res.json()
  if (!res.ok) {
    throw new Error(data.message || 'Request failed')
  }
  return data
}

export const portalService = {
  getMyCompany: (token) => request('/companies/me', { token }),
  updateMyCompany: (token, body) => request('/companies/me', { token, method: 'PATCH', body }),
  getMyBookings: (token) => request('/bookings/mine', { token }),
  createBooking: (token, body) => request('/bookings', { token, method: 'POST', body }),
  getMyInvoices: (token) => request('/invoices/mine', { token }),
  getMyContracts: (token) => request('/contracts/mine', { token }),
  signContract: (token, id) => request(`/contracts/${id}/sign`, { token, method: 'PATCH' }),
  getMyKycDocuments: (token) => request('/kyc-documents/mine', { token }),
  uploadKycDocument: (token, formData) => request('/kyc-documents/mine', { token, method: 'POST', body: formData }),
  getMyPaymentRequests: (token) => request('/payment-requests/mine', { token }),
  payPaymentRequest: (token, id) => request(`/payment-requests/${id}/pay`, { token, method: 'PATCH' }),
  getMyNotifications: (token) => request('/notifications/mine', { token }),
  markNotificationRead: (token, id) => request(`/notifications/${id}/read`, { token, method: 'PATCH' }),
  dismissNotification: (token, id) => request(`/notifications/${id}`, { token, method: 'DELETE' }),
  getPromotions: (token) => request('/promotions', { token }),
  createPromotion: (token, body) => request('/promotions', { token, method: 'POST', body }),
  getQuote: (body) => request('/pricing/quote', { method: 'POST', body }),
  suggestAddresses: (q, { sessionToken, country } = {}) => {
    const params = new URLSearchParams({ q: q || '' })
    if (sessionToken) params.set('sessionToken', sessionToken)
    if (country) params.set('country', country)
    return request(`/places/autocomplete?${params.toString()}`)
  },
  getAddressDetails: (placeId, { sessionToken } = {}) => {
    const params = new URLSearchParams({ placeId })
    if (sessionToken) params.set('sessionToken', sessionToken)
    return request(`/places/details?${params.toString()}`)
  },
  submitLead: (body) => request('/leads', { method: 'POST', body }),
  // Stage 2 — e-commerce marketplace
  listEcommerceStores: (token) => request('/ecommerce/stores', { token }),
  connectEcommerceStore: (token, body) =>
    request('/ecommerce/stores', { token, method: 'POST', body }),
  updateEcommerceStore: (token, connectionId, body) =>
    request(`/ecommerce/stores/${connectionId}`, { token, method: 'PATCH', body }),
  disconnectEcommerceStore: (token, connectionId) =>
    request(`/ecommerce/stores/${connectionId}`, { token, method: 'DELETE' }),
  createMarketplaceQuote: (token, body) =>
    request('/ecommerce/quotes', { token, method: 'POST', body }),
  createMarketplacePayment: (token, bookingId, body) =>
    request(`/ecommerce/bookings/${bookingId}/pay`, { token, method: 'POST', body }),
  confirmMarketplacePayment: (token, paymentIntentId) =>
    request(`/ecommerce/payments/${paymentIntentId}/confirm`, { token, method: 'POST' }),
  getPaymentConfig: (token) => request('/ecommerce/payments/config', { token }),
  ingestStoreOrder: (token, connectionId, body) =>
    request(`/ecommerce/stores/${connectionId}/orders`, { token, method: 'POST', body }),
  resolveFileUrl: (fileUrl) => {
    if (!fileUrl) return null
    if (fileUrl.startsWith('http://') || fileUrl.startsWith('https://')) return fileUrl
    return `${API_ORIGIN}${fileUrl}`
  },
  apiBaseUrl: API_BASE_URL,
  apiOrigin: API_ORIGIN,
}
