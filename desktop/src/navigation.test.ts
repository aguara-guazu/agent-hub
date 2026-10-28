import { describe, expect, it } from 'vitest'
import { allowedRoute, NavigationRelay } from './navigation.js'

describe('rutas permitidas', () => {
  it('acepta Entregas, el detalle de una entrega, Programaciones (con foco) y Ajustes', () => {
    expect(allowedRoute('/deliveries')).toBe('/deliveries')
    expect(allowedRoute('/deliveries/3f6c1d2e-8a4b-4c5d-9e7f-0a1b2c3d4e5f')).toBe('/deliveries/3f6c1d2e-8a4b-4c5d-9e7f-0a1b2c3d4e5f')
    expect(allowedRoute('/schedules')).toBe('/schedules')
    expect(allowedRoute('/schedules?focus=abc_123')).toBe('/schedules?focus=abc_123')
    expect(allowedRoute('/settings')).toBe('/settings')
  })

  it('rechaza URLs, rutas con consulta o fragmento y tipos que no son texto', () => {
    for (const route of ['https://evil.example/', '//evil.example', '/deliveries/', '/deliveries/a/b', '/deliveries/a?x=1', '/deliveries/a#b', '/deliveries/../settings', '/schedules?focus=', '/schedules?focus=a&x=1', '/schedules?x=1', '/brief/abc', '/catalog', '#/schedules', '', null, undefined, 7, {}]) {
      expect(allowedRoute(route)).toBeNull()
    }
  })

  it('rechaza ids con caracteres de ruta o más largos que el tope', () => {
    expect(allowedRoute('/deliveries/a%2Fb')).toBeNull()
    expect(allowedRoute(`/deliveries/${'a'.repeat(81)}`)).toBeNull()
    expect(allowedRoute(`/deliveries/${'a'.repeat(80)}`)).not.toBeNull()
  })
})

describe('NavigationRelay', () => {
  it('entrega al instante cuando el renderer escucha', () => {
    const sent: string[] = []
    const relay = new NavigationRelay(route => sent.push(route))
    expect(relay.attach()).toBeNull()
    expect(relay.request('/deliveries/abc')).toBe(true)
    expect(sent).toEqual(['/deliveries/abc'])
  })

  it('guarda la última ruta mientras el renderer no escucha y la entrega al declararse listo', () => {
    const sent: string[] = []
    const relay = new NavigationRelay(route => sent.push(route))
    relay.request('/deliveries/uno')
    relay.request('/deliveries/dos')
    expect(sent).toEqual([])
    expect(relay.attach()).toBe('/deliveries/dos')
    expect(relay.attach()).toBeNull()
  })

  it('vuelve a guardar tras detach (recarga de la página)', () => {
    const sent: string[] = []
    const relay = new NavigationRelay(route => sent.push(route))
    relay.attach()
    relay.detach()
    relay.request('/schedules')
    expect(sent).toEqual([])
    expect(relay.attach()).toBe('/schedules')
  })

  it('no acepta ni guarda rutas fuera de la lista blanca', () => {
    const sent: string[] = []
    const relay = new NavigationRelay(route => sent.push(route))
    expect(relay.request('https://evil.example/')).toBe(false)
    expect(relay.attach()).toBeNull()
    expect(sent).toEqual([])
  })
})
