'use client';

import { ClipboardList, MessageSquare, Mail, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslations } from '@/i18n/context';

type Tab = 'threads' | 'dms' | 'tasks';

interface SidebarProps {
  open: boolean;
  onClose: () => void;
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  children?: React.ReactNode;
}

export function Sidebar({ open, onClose, activeTab, onTabChange, children }: SidebarProps) {
  const { t } = useTranslations();
  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'tasks', label: t('sidebar.tasks'), icon: <ClipboardList size={14} aria-hidden="true" /> },
    { id: 'threads', label: t('sidebar.threads'), icon: <MessageSquare size={14} /> },
    { id: 'dms', label: t('sidebar.dms'), icon: <Mail size={14} /> },
  ];

  return (
    <>
      {/* Mobile overlay */}
      {open && (
        <div className="fixed inset-0 theme-overlay glass z-[999] md:hidden" onClick={onClose} />
      )}

      <aside
        className={cn(
          'glass theme-sidebar border-r border-hxa-border flex flex-col w-[300px] shrink-0 overflow-hidden',
          'max-md:fixed max-md:top-0 max-md:left-0 max-md:bottom-0 max-md:z-[1000] max-md:transition-transform max-md:duration-300',
          open ? 'max-md:translate-x-0' : 'max-md:-translate-x-full',
        )}
      >
        {/* Mobile close button */}
        <div className="flex min-h-12 items-center justify-between border-b border-hxa-border px-3 md:hidden">
          <span className="text-sm font-medium text-hxa-text">{t('sidebar.navigation')}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('sidebar.close')}
            className="flex h-10 w-10 items-center justify-center rounded-lg text-hxa-text-dim hover:bg-hxa-bg-hover hover:text-hxa-text focus-visible:outline-2 focus-visible:outline-hxa-accent"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex shrink-0 border-b border-hxa-border theme-input">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              aria-current={activeTab === tab.id ? 'page' : undefined}
              onClick={() => onTabChange(tab.id)}
              className={cn(
                'flex-1 py-3.5 text-center text-sm font-semibold relative transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-hxa-accent',
                activeTab === tab.id
                  ? 'text-hxa-accent'
                  : 'text-hxa-text-dim hover:text-hxa-text hover:bg-hxa-bg-hover',
              )}
            >
              <span className="inline-flex items-center gap-1.5">
                {tab.icon}
                {tab.label}
              </span>
              {activeTab === tab.id && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-hxa-accent to-hxa-purple" />
              )}
            </button>
          ))}
        </div>

        {/* Panel content */}
        <div className="flex-1 overflow-y-auto p-2 min-h-0">
          {children}
        </div>
      </aside>
    </>
  );
}
