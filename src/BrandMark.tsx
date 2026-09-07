import logo from '../assets/app-icon.png';
import './brandMark.css';

export function BrandMark({ size = 36 }: { size?: number }) {
  return <img className="brand-mark" src={logo} width={size} height={size} alt="" aria-hidden="true" draggable={false} />;
}
