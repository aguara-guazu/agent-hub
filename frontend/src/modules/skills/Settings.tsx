import { Link } from 'react-router-dom'
import { useT } from '../../i18n'

export default function Settings() {
  const { t } = useT('settings')
  return <Link className="btn" to="/skills">{t('modules.skills')}</Link>
}
