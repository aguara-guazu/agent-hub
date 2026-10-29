import type { ReactNode } from "react"
import type { IconName } from "../Icon"
import { BtnGroup, Button, IconButton } from "./basics"
import { Menu, type MenuItem } from "./Menu"
import { useT } from "../../i18n"

/** El «…» de una vista, fila o panel. */
export function MoreMenu({ items, label, small = false, ghost = false }: { items: readonly MenuItem[]; label?: string; small?: boolean; ghost?: boolean }) {
  const { t } = useT("common")
  const text = label ?? t("a11y.moreActions")
  return (
    <Menu
      items={items}
      label={text}
      trigger={props => <IconButton {...props} icon="more" label={text} small={small} variant={ghost ? "ghost" : "default"} />}
    />
  )
}

/** Primario con variantes: «Nuevo proyecto ▾». */
export function SplitButton({ children, onClick, icon, items, menuLabel, disabled }: { children: ReactNode; onClick: () => void; icon?: IconName; items: readonly MenuItem[]; menuLabel: string; disabled?: boolean }) {
  return (
    <BtnGroup>
      <Button variant="primary" icon={icon} onClick={onClick} disabled={disabled}>{children}</Button>
      <Menu
        items={items}
        label={menuLabel}
        trigger={props => <IconButton {...props} variant="primary" icon="down" label={menuLabel} disabled={disabled} />}
      />
    </BtnGroup>
  )
}
