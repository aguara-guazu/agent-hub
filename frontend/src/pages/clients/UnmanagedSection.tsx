import { Link } from "react-router-dom"
import { List, Tag } from "../../components/ui"
import { useT } from "../../i18n"
import type { LocalClient } from "../../lib/local"
import { shortenPath } from "./state"

interface Item { key: string; kind: "server" | "skill"; name: string; path: string; linked: boolean; href: string | null }

/** Servidores y skills que el cliente carga por su cuenta. Sin inventario (daemon viejo) no se muestra nada. */
export function UnmanagedSection({ client }: { client: LocalClient }) {
  const { t, plural } = useT("clients")
  const inventory = client.unmanaged
  if (!inventory) return null
  const items: Item[] = [
    ...inventory.servers.map(server => ({
      key: `server:${server.path}:${server.name}`, kind: "server" as const, name: server.name, path: server.path, linked: false,
      href: server.catalog_server_id ? `/servers?focus=${encodeURIComponent(server.catalog_server_id)}` : null,
    })),
    ...inventory.skills.map(skill => ({
      key: `skill:${skill.path}`, kind: "skill" as const, name: skill.slug, path: skill.path, linked: skill.linked,
      href: skill.catalog_skill_id ? `/skills?focus=${encodeURIComponent(skill.catalog_skill_id)}` : null,
    })),
  ]
  if (items.length === 0 && inventory.errors.length === 0) return null
  return (
    <div className="field">
      <span className="label">{t("unmanaged.title")}</span>
      {items.length > 0 && (
        <List>
          {items.map(item => (
            <div className="row" key={item.key} style={{ minHeight: 46 }}>
              <div className="row-main">
                {item.href
                  ? <Link className="row-title mono" to={item.href} title={t("unmanaged.openInHub", { name: item.name })}>{item.name}</Link>
                  : <span className="row-title mono" title={item.name}>{item.name}</span>}
                <span className="row-sub mono" title={item.path}>{shortenPath(item.path)}</span>
              </div>
              <div className="row-meta">
                <Tag>{t(item.kind === "server" ? "unmanaged.server" : item.linked ? "unmanaged.linkedSkill" : "unmanaged.skill")}</Tag>
                <span className="xs t3">{t("unmanaged.notConnected")}</span>
              </div>
            </div>
          ))}
        </List>
      )}
      {(inventory.truncated || inventory.errors.length > 0) && (
        <span className="hint" title={inventory.errors.map(error => error.path).join("\n") || undefined}>
          {[inventory.truncated ? t("unmanaged.truncated") : null, inventory.errors.length ? plural("unmanaged.errors", inventory.errors.length) : null].filter(Boolean).join(" ")}
        </span>
      )}
    </div>
  )
}
