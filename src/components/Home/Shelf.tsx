import { ReactNode } from "react";
import "./Shelf.css";

interface Props {
  title: string;
  /** Ссылка справа от заголовка: «Показать все» и тому подобное. */
  action?: {
    label: string;
    onClick: () => void;
  };
  children: ReactNode;
}

/**
 * Полка-карусель главной: заголовок и горизонтальная прокрутка карточек.
 *
 * Карточки фиксированной ширины, прокрутка — колесом с Shift и перетаскиванием,
 * как на главных страницах стриминговых сервисов.
 */
export default function Shelf({ title, action, children }: Props) {
  return (
    <div className="section shelf">
      <div className="section-header">
        <span className="section-title">{title}</span>
        {action && (
          <button className="section-more" onClick={action.onClick}>
            {action.label}
          </button>
        )}
      </div>
      <div className="shelf-scroll">{children}</div>
    </div>
  );
}
