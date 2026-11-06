import type {ReactNode} from 'react';
import {Link} from 'react-router-dom';
import {Card} from '../components/ui/kit';
import {useData} from './data';
export function FeatureGate({level='planner',children}:{level?:'planner'|'full';children:ReactNode}) {
  const {user}=useData();
  const allowed=level==='full'?user.settings.featurePreset==='full':user.settings.featurePreset!=='simple';
  return allowed?<>{children}</>:<Card><h2>Choose the features you want to see</h2><p className="muted">This screen is available with the {level==='full'?'Full':'Planner'} preset. Changing visibility preserves all your saved work.</p><Link className="button button-primary" to="/settings#features">Open Features</Link></Card>;
}
