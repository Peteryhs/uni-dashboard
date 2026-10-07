import { Carrot, MilkOff, MoonStar, Sprout, WheatOff, type LucideIcon } from 'lucide-react';
import { dietTag } from '@/lib/menu';

const ICONS: Record<string, LucideIcon> = {
  vegetarian: Carrot,
  vegan: Sprout,
  halal: MoonStar,
  gluten: WheatOff,
  dairy: MilkOff,
};

export function DietaryIcon({ tag }: { tag: string }) {
  const { label } = dietTag(tag);
  const Icon = ICONS[tag.toLowerCase()];
  return Icon
    ? <span className="diet-icon" role="img" aria-label={label} title={label}><Icon size={14} aria-hidden="true" /></span>
    : <span className="diet-label" title={label}>{label}</span>;
}
