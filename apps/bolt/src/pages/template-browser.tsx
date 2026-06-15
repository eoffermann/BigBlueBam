import { Loader2, LayoutTemplate, Zap } from 'lucide-react';
import { useTemplates, useInstantiateTemplate, type BoltTemplate } from '@/hooks/use-templates';
import type { TriggerSource } from '@/hooks/use-automations';
import { Badge } from '@/components/common/badge';
import { Button } from '@/components/common/button';

interface TemplateBrowserPageProps {
  onNavigate: (path: string) => void;
}

const sourceColors: Record<TriggerSource, string> = {
  bam: '#2563eb',
  banter: '#7c3aed',
  beacon: '#059669',
  brief: '#d97706',
  helpdesk: '#dc2626',
  schedule: '#6b7280',
  bond: '#0891b2',
  blast: '#db2777',
  board: '#9333ea',
  bench: '#0d9488',
  bearing: '#ea580c',
  bill: '#16a34a',
  book: '#4f46e5',
  blank: '#64748b',
};

function TemplateCard({ template, onInstantiate, isInstantiating }: {
  template: BoltTemplate;
  onInstantiate: () => void;
  isInstantiating: boolean;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800/50 p-5 flex flex-col hover:border-zinc-300 dark:hover:border-zinc-600 transition-colors">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center justify-center h-10 w-10 rounded-lg bg-primary-50 dark:bg-primary-900/20">
          <Zap className="h-5 w-5 text-primary-600 dark:text-primary-400" />
        </div>
        <Badge color={sourceColors[template.trigger_source]}>
          {template.trigger_source}
        </Badge>
      </div>

      <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-1">
        {template.name}
      </h3>
      <p className="text-xs text-zinc-500 flex-1 mb-3 line-clamp-2">
        {template.description}
      </p>

      <div className="flex items-center justify-between">
        <span className="text-xs text-zinc-400 font-mono">{template.trigger_event}</span>
        <Button
          size="sm"
          variant="secondary"
          onClick={onInstantiate}
          loading={isInstantiating}
        >
          Use Template
        </Button>
      </div>
    </div>
  );
}

export function TemplateBrowserPage({ onNavigate }: TemplateBrowserPageProps) {
  const { data: response, isLoading } = useTemplates();
  const instantiate = useInstantiateTemplate();

  const templates = response?.data ?? [];

  const handleInstantiate = async (templateId: string) => {
    const result = await instantiate.mutateAsync(templateId);
    onNavigate(`/automations/${result.data.id}`);
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Templates</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Start with a pre-built automation template and customize it.
        </p>
      </div>

      {/* Grid */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
        </div>
      ) : templates.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-zinc-400">
          <LayoutTemplate className="h-12 w-12 mb-4 opacity-30" />
          <p className="text-lg font-medium">No templates available</p>
          <p className="text-sm mt-1">Templates will appear here once they are created.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {templates.map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              onInstantiate={() => handleInstantiate(template.id)}
              isInstantiating={instantiate.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}
