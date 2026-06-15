import { useState } from 'react';
import { Layers, FormInput, Star, Plus, Trash2, GripVertical, Edit2, X, Mail } from 'lucide-react';
import { Button } from '@/components/common/button';
import { Input } from '@/components/common/input';
import { Badge } from '@/components/common/badge';
import { Dialog } from '@/components/common/dialog';
import { Select } from '@/components/common/select';
import { cn } from '@/lib/utils';
import { usePipelines, useCreatePipeline, useCreateStage, useDeleteStage, type PipelineStage } from '@/hooks/use-pipelines';
import {
  useScoringRules,
  useCreateScoringRule,
  useUpdateScoringRule,
  useDeleteScoringRule,
  type ScoringRule,
} from '@/hooks/use-scoring';
import {
  useCustomFieldDefinitions,
  useCreateCustomField,
  useDeleteCustomField,
  type CustomFieldDefinition,
  type CustomFieldOption,
} from '@/hooks/use-custom-fields';
import { Loader2 } from 'lucide-react';
import { useUserSettings, useUpdateUserSettings } from '@/hooks/use-user-settings';

interface SettingsPageProps {
  onNavigate: (path: string) => void;
  activeTab?: 'pipelines' | 'fields' | 'scoring' | 'email';
}

/* ------------------------------------------------------------------ */
/*  Pipelines settings tab                                             */
/* ------------------------------------------------------------------ */

function PipelinesSettings() {
  const { data, isLoading } = usePipelines();
  const pipelines = data?.data ?? [];
  const createPipeline = useCreatePipeline();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [expandedPipelineId, setExpandedPipelineId] = useState<string | null>(null);

  const handleCreatePipeline = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    await createPipeline.mutateAsync({
      name: newName.trim(),
      stages: [
        { name: 'Prospect', stage_type: 'active', probability_pct: 10, color: '#3b82f6' },
        { name: 'Qualified', stage_type: 'active', probability_pct: 25, color: '#8b5cf6' },
        { name: 'Proposal', stage_type: 'active', probability_pct: 50, color: '#f59e0b' },
        { name: 'Negotiation', stage_type: 'active', probability_pct: 75, color: '#f97316' },
        { name: 'Closed Won', stage_type: 'won', probability_pct: 100, color: '#16a34a' },
        { name: 'Closed Lost', stage_type: 'lost', probability_pct: 0, color: '#dc2626' },
      ],
    });
    setNewName('');
    setShowCreate(false);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-primary-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Pipelines</h3>
          <p className="text-sm text-zinc-500 mt-0.5">Configure deal pipelines and their stages.</p>
        </div>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4" />
          New Pipeline
        </Button>
      </div>

      {pipelines.length === 0 ? (
        <div className="text-center py-12 text-sm text-zinc-500">
          No pipelines configured. Create your first pipeline to get started.
        </div>
      ) : (
        <div className="space-y-4">
          {pipelines.map((pipeline) => {
            const isExpanded = expandedPipelineId === pipeline.id;
            const stages = [...(pipeline.stages ?? [])].sort((a, b) => a.sort_order - b.sort_order);

            return (
              <div
                key={pipeline.id}
                className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden"
              >
                <button
                  onClick={() => setExpandedPipelineId(isExpanded ? null : pipeline.id)}
                  className="flex items-center justify-between w-full px-5 py-4 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <Layers className="h-4 w-4 text-primary-500" />
                    <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                      {pipeline.name}
                    </span>
                    {pipeline.is_default && <Badge variant="primary">Default</Badge>}
                    <span className="text-xs text-zinc-400">{stages.length} stages</span>
                  </div>
                  <span className="text-xs text-zinc-400">{pipeline.currency}</span>
                </button>

                {isExpanded && (
                  <div className="border-t border-zinc-100 dark:border-zinc-800 px-5 py-4">
                    <div className="space-y-2">
                      {stages.map((stage) => (
                        <StageRow key={stage.id} stage={stage} pipelineId={pipeline.id} />
                      ))}
                    </div>
                    <AddStageForm pipelineId={pipeline.id} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Dialog
        open={showCreate}
        onOpenChange={setShowCreate}
        title="Create Pipeline"
        description="A new pipeline with default stages will be created."
      >
        <form onSubmit={handleCreatePipeline} className="space-y-4">
          <Input
            label="Pipeline Name"
            placeholder="e.g., Enterprise Sales"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            required
            autoFocus
          />
          <div className="flex justify-end gap-3">
            <Button variant="secondary" type="button" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={createPipeline.isPending}>
              Create
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

function StageRow({ stage, pipelineId }: { stage: PipelineStage; pipelineId: string }) {
  const deleteStage = useDeleteStage(pipelineId);

  const stageTypeLabel = stage.stage_type === 'won' ? 'Won' : stage.stage_type === 'lost' ? 'Lost' : 'Active';
  const stageTypeBadge = stage.stage_type === 'won' ? 'success' : stage.stage_type === 'lost' ? 'danger' : 'default';

  return (
    <div className="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-zinc-50 dark:hover:bg-zinc-800/50 group">
      <GripVertical className="h-4 w-4 text-zinc-300 cursor-grab" />
      <div
        className="h-3 w-3 rounded-full shrink-0"
        style={{ backgroundColor: stage.color ?? '#0891b2' }}
      />
      <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 flex-1">
        {stage.name}
      </span>
      <Badge variant={stageTypeBadge as any}>{stageTypeLabel}</Badge>
      <span className="text-xs text-zinc-400 w-12 text-right">{stage.probability_pct}%</span>
      {stage.rotting_days && (
        <span className="text-xs text-orange-500">{stage.rotting_days}d rot</span>
      )}
      <button
        onClick={() => deleteStage.mutate(stage.id)}
        className="opacity-0 group-hover:opacity-100 rounded p-1 text-zinc-400 hover:text-red-500 transition-all"
        title="Delete stage"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function AddStageForm({ pipelineId }: { pipelineId: string }) {
  const [name, setName] = useState('');
  const [stageType, setStageType] = useState('active');
  const createStage = useCreateStage(pipelineId);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    await createStage.mutateAsync({
      name: name.trim(),
      stage_type: stageType as 'active' | 'won' | 'lost',
    });
    setName('');
    setStageType('active');
  };

  return (
    <form onSubmit={handleSubmit} className="flex items-end gap-3 mt-4 pt-4 border-t border-zinc-100 dark:border-zinc-800">
      <div className="flex-1">
        <Input
          placeholder="New stage name..."
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="w-32">
        <Select
          value={stageType}
          onValueChange={setStageType}
          options={[
            { value: 'active', label: 'Active' },
            { value: 'won', label: 'Won' },
            { value: 'lost', label: 'Lost' },
          ]}
        />
      </div>
      <Button type="submit" size="sm" loading={createStage.isPending} disabled={!name.trim()}>
        Add
      </Button>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/*  Custom fields settings tab                                         */
/* ------------------------------------------------------------------ */

const ENTITY_TYPES = [
  { value: 'contact', label: 'Contact' },
  { value: 'company', label: 'Company' },
  { value: 'deal', label: 'Deal' },
] as const;

const FIELD_TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'select', label: 'Select' },
  { value: 'multi_select', label: 'Multi Select' },
  { value: 'url', label: 'URL' },
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
  { value: 'boolean', label: 'Boolean' },
];

const ENTITY_FILTER_ALL = '__all__';

function FieldsSettings() {
  const [entityFilter, setEntityFilter] = useState<string>(ENTITY_FILTER_ALL);
  const { data, isLoading } = useCustomFieldDefinitions(
    entityFilter === ENTITY_FILTER_ALL ? undefined : entityFilter,
  );
  const fields = data?.data ?? [];
  const deleteField = useDeleteCustomField();
  const [showCreate, setShowCreate] = useState(false);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-primary-500" />
      </div>
    );
  }

  const groupedFields: Record<string, CustomFieldDefinition[]> = {};
  for (const field of fields) {
    const bucket = groupedFields[field.entity_type] ?? [];
    bucket.push(field);
    groupedFields[field.entity_type] = bucket;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Custom Fields</h3>
          <p className="text-sm text-zinc-500 mt-0.5">
            Define custom fields for contacts, companies, and deals.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="w-36">
            <Select
              value={entityFilter}
              onValueChange={setEntityFilter}
              options={[
                { value: ENTITY_FILTER_ALL, label: 'All Types' },
                ...ENTITY_TYPES.map((t) => ({ value: t.value, label: t.label })),
              ]}
              placeholder="Filter..."
            />
          </div>
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" />
            New Field
          </Button>
        </div>
      </div>

      {fields.length === 0 ? (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-8 text-center">
          <FormInput className="h-8 w-8 text-zinc-300 mx-auto mb-3" />
          <p className="text-sm text-zinc-500">
            No custom fields defined yet. Create your first field to extend contacts, companies, or deals with custom data.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(groupedFields).map(([entityType, entityFields]) => (
            <div key={entityType}>
              <h4 className="text-sm font-semibold text-zinc-500 uppercase tracking-wider mb-3">
                {entityType} fields
              </h4>
              <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden divide-y divide-zinc-100 dark:divide-zinc-800">
                {entityFields.map((field) => (
                  <div
                    key={field.id}
                    className="flex items-center gap-4 px-5 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 group"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                          {field.label}
                        </span>
                        {field.required && (
                          <Badge variant="warning">Required</Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <code className="text-xs text-zinc-400 bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded">
                          {field.field_key}
                        </code>
                      </div>
                    </div>
                    <Badge variant="info">{field.field_type}</Badge>
                    {(field.field_type === 'select' || field.field_type === 'multi_select') &&
                      field.options && (
                        <span className="text-xs text-zinc-400">
                          {(field.options as CustomFieldOption[]).length} options
                        </span>
                      )}
                    <button
                      onClick={() => deleteField.mutate(field.id)}
                      className="opacity-0 group-hover:opacity-100 rounded p-1 text-zinc-400 hover:text-red-500 transition-all"
                      title="Delete field"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <CreateCustomFieldDialog
        open={showCreate}
        onOpenChange={setShowCreate}
      />
    </div>
  );
}

function CreateCustomFieldDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createField = useCreateCustomField();
  const [entityType, setEntityType] = useState('contact');
  const [fieldKey, setFieldKey] = useState('');
  const [label, setLabel] = useState('');
  const [fieldType, setFieldType] = useState('text');
  const [required, setRequired] = useState(false);
  const [options, setOptions] = useState<CustomFieldOption[]>([]);
  const [newOptionValue, setNewOptionValue] = useState('');
  const [newOptionLabel, setNewOptionLabel] = useState('');

  const showOptions = fieldType === 'select' || fieldType === 'multi_select';

  const handleAddOption = () => {
    if (!newOptionValue.trim() || !newOptionLabel.trim()) return;
    setOptions([...options, { value: newOptionValue.trim(), label: newOptionLabel.trim() }]);
    setNewOptionValue('');
    setNewOptionLabel('');
  };

  const handleRemoveOption = (index: number) => {
    setOptions(options.filter((_, i) => i !== index));
  };

  const resetForm = () => {
    setEntityType('contact');
    setFieldKey('');
    setLabel('');
    setFieldType('text');
    setRequired(false);
    setOptions([]);
    setNewOptionValue('');
    setNewOptionLabel('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fieldKey.trim() || !label.trim()) return;

    await createField.mutateAsync({
      entity_type: entityType as 'contact' | 'company' | 'deal',
      field_key: fieldKey.trim(),
      label: label.trim(),
      field_type: fieldType,
      required,
      options: showOptions && options.length > 0 ? options : undefined,
    });

    resetForm();
    onOpenChange(false);
  };

  // Auto-generate field_key from label
  const handleLabelChange = (val: string) => {
    setLabel(val);
    if (!fieldKey || fieldKey === labelToKey(label)) {
      setFieldKey(labelToKey(val));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) resetForm();
        onOpenChange(v);
      }}
      title="Create Custom Field"
      description="Add a custom field to extend the data model for a specific entity type."
      className="max-w-xl"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Select
            value={entityType}
            onValueChange={setEntityType}
            options={ENTITY_TYPES.map((t) => ({ value: t.value, label: t.label }))}
            label="Entity Type"
          />
          <Select
            value={fieldType}
            onValueChange={setFieldType}
            options={FIELD_TYPES}
            label="Field Type"
          />
        </div>
        <Input
          label="Label"
          placeholder="e.g., Company Size"
          value={label}
          onChange={(e) => handleLabelChange(e.target.value)}
          required
          autoFocus
        />
        <Input
          label="Field Key"
          placeholder="e.g., company_size"
          value={fieldKey}
          onChange={(e) => setFieldKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
          required
        />
        <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300 cursor-pointer">
          <input
            type="checkbox"
            checked={required}
            onChange={(e) => setRequired(e.target.checked)}
            className="rounded border-zinc-300 text-primary-600 focus:ring-primary-500"
          />
          Required field
        </label>

        {showOptions && (
          <div className="space-y-3">
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Options</span>
            {options.length > 0 && (
              <div className="space-y-1.5">
                {options.map((opt, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm">
                    <code className="bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 rounded text-xs text-zinc-600 dark:text-zinc-400">
                      {opt.value}
                    </code>
                    <span className="text-zinc-700 dark:text-zinc-300 flex-1">{opt.label}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveOption(i)}
                      className="text-zinc-400 hover:text-red-500"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Input
                  placeholder="Value"
                  value={newOptionValue}
                  onChange={(e) => setNewOptionValue(e.target.value)}
                />
              </div>
              <div className="flex-1">
                <Input
                  placeholder="Label"
                  value={newOptionLabel}
                  onChange={(e) => setNewOptionLabel(e.target.value)}
                />
              </div>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={handleAddOption}
                disabled={!newOptionValue.trim() || !newOptionLabel.trim()}
              >
                Add
              </Button>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={() => { resetForm(); onOpenChange(false); }}>
            Cancel
          </Button>
          <Button type="submit" loading={createField.isPending} disabled={!fieldKey.trim() || !label.trim()}>
            Create Field
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function labelToKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60);
}

/* ------------------------------------------------------------------ */
/*  Lead scoring settings tab                                          */
/* ------------------------------------------------------------------ */

const CONDITION_FIELDS = [
  { value: 'lifecycle_stage', label: 'Lifecycle Stage' },
  { value: 'lead_source', label: 'Lead Source' },
  { value: 'title', label: 'Job Title' },
  { value: 'city', label: 'City' },
  { value: 'country', label: 'Country' },
  { value: 'lead_score', label: 'Current Score' },
  { value: 'custom_fields.company_size', label: 'Company Size (custom)' },
  { value: 'custom_fields.industry', label: 'Industry (custom)' },
];

const CONDITION_OPERATORS = [
  { value: 'equals', label: 'Equals' },
  { value: 'not_equals', label: 'Not Equals' },
  { value: 'contains', label: 'Contains' },
  { value: 'gt', label: 'Greater Than' },
  { value: 'lt', label: 'Less Than' },
  { value: 'gte', label: 'Greater or Equal' },
  { value: 'lte', label: 'Less or Equal' },
  { value: 'exists', label: 'Exists' },
  { value: 'not_exists', label: 'Not Exists' },
];

function ScoringSettings() {
  const { data, isLoading } = useScoringRules();
  const rules = data?.data ?? [];
  const deleteRule = useDeleteScoringRule();
  const [showCreate, setShowCreate] = useState(false);
  const [editingRule, setEditingRule] = useState<ScoringRule | null>(null);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-primary-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Lead Scoring</h3>
          <p className="text-sm text-zinc-500 mt-0.5">
            Configure rules to automatically score contacts based on their attributes and behavior.
          </p>
        </div>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4" />
          New Rule
        </Button>
      </div>

      {rules.length > 0 && (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/30 p-3">
          <p className="text-xs text-zinc-500">
            Scores are calculated per contact by evaluating all enabled rules. Each matching rule adds (or subtracts) its
            point delta. Final score is clamped to 0-100.
          </p>
        </div>
      )}

      {rules.length === 0 ? (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-8 text-center">
          <Star className="h-8 w-8 text-zinc-300 mx-auto mb-3" />
          <p className="text-sm text-zinc-500">
            No scoring rules configured yet. Create rules to automatically score contacts
            based on lifecycle stage, lead source, custom fields, and more.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden divide-y divide-zinc-100 dark:divide-zinc-800">
          {rules.map((rule) => (
            <ScoringRuleRow
              key={rule.id}
              rule={rule}
              onEdit={() => setEditingRule(rule)}
              onDelete={() => deleteRule.mutate(rule.id)}
            />
          ))}
        </div>
      )}

      <CreateScoringRuleDialog
        open={showCreate}
        onOpenChange={setShowCreate}
      />

      {editingRule && (
        <EditScoringRuleDialog
          rule={editingRule}
          open={true}
          onOpenChange={(v) => { if (!v) setEditingRule(null); }}
        />
      )}
    </div>
  );
}

function ScoringRuleRow({
  rule,
  onEdit,
  onDelete,
}: {
  rule: ScoringRule;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const operatorLabel =
    CONDITION_OPERATORS.find((o) => o.value === rule.condition_operator)?.label ?? rule.condition_operator;
  const fieldLabel =
    CONDITION_FIELDS.find((f) => f.value === rule.condition_field)?.label ?? rule.condition_field;

  const needsValue = rule.condition_operator !== 'exists' && rule.condition_operator !== 'not_exists';

  return (
    <div className="flex items-center gap-4 px-5 py-3.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 group">
      <div
        className={cn(
          'h-2 w-2 rounded-full shrink-0',
          rule.enabled ? 'bg-green-500' : 'bg-zinc-300 dark:bg-zinc-600',
        )}
        title={rule.enabled ? 'Enabled' : 'Disabled'}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {rule.name}
          </span>
          {!rule.enabled && <Badge variant="default">Disabled</Badge>}
        </div>
        <p className="text-xs text-zinc-500 mt-0.5">
          When <span className="font-medium text-zinc-600 dark:text-zinc-400">{fieldLabel}</span>{' '}
          <span className="text-zinc-400">{operatorLabel.toLowerCase()}</span>
          {needsValue && (
            <>
              {' '}
              <code className="bg-zinc-100 dark:bg-zinc-800 px-1 py-0.5 rounded text-zinc-600 dark:text-zinc-400">
                {rule.condition_value}
              </code>
            </>
          )}
        </p>
        {rule.description && (
          <p className="text-xs text-zinc-400 mt-0.5">{rule.description}</p>
        )}
      </div>
      <div
        className={cn(
          'text-sm font-semibold tabular-nums px-2 py-0.5 rounded',
          rule.score_delta > 0
            ? 'text-green-700 bg-green-50 dark:text-green-400 dark:bg-green-900/20'
            : rule.score_delta < 0
              ? 'text-red-700 bg-red-50 dark:text-red-400 dark:bg-red-900/20'
              : 'text-zinc-500',
        )}
      >
        {rule.score_delta > 0 ? '+' : ''}{rule.score_delta} pts
      </div>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={onEdit}
          className="rounded p-1 text-zinc-400 hover:text-primary-500 transition-colors"
          title="Edit rule"
        >
          <Edit2 className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={onDelete}
          className="rounded p-1 text-zinc-400 hover:text-red-500 transition-colors"
          title="Delete rule"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function CreateScoringRuleDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createRule = useCreateScoringRule();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [conditionField, setConditionField] = useState('lifecycle_stage');
  const [conditionOperator, setConditionOperator] = useState('equals');
  const [conditionValue, setConditionValue] = useState('');
  const [scoreDelta, setScoreDelta] = useState('10');
  const [enabled, setEnabled] = useState(true);

  const needsValue = conditionOperator !== 'exists' && conditionOperator !== 'not_exists';

  const resetForm = () => {
    setName('');
    setDescription('');
    setConditionField('lifecycle_stage');
    setConditionOperator('equals');
    setConditionValue('');
    setScoreDelta('10');
    setEnabled(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const delta = parseInt(scoreDelta, 10);
    if (isNaN(delta)) return;

    await createRule.mutateAsync({
      name: name.trim(),
      description: description.trim() || undefined,
      condition_field: conditionField,
      condition_operator: conditionOperator,
      condition_value: needsValue ? conditionValue : '_',
      score_delta: delta,
      enabled,
    });

    resetForm();
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) resetForm();
        onOpenChange(v);
      }}
      title="Create Scoring Rule"
      description="Define a condition that adds or subtracts points from a contact's lead score."
      className="max-w-xl"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="Rule Name"
          placeholder="e.g., +10 for Sales Qualified"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          autoFocus
        />
        <Input
          label="Description (optional)"
          placeholder="Brief explanation of this rule"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />

        <div className="space-y-2">
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Condition</span>
          <div className="grid grid-cols-3 gap-3">
            <Select
              value={conditionField}
              onValueChange={setConditionField}
              options={CONDITION_FIELDS}
              placeholder="Field..."
            />
            <Select
              value={conditionOperator}
              onValueChange={setConditionOperator}
              options={CONDITION_OPERATORS}
              placeholder="Operator..."
            />
            {needsValue && (
              <Input
                placeholder="Value..."
                value={conditionValue}
                onChange={(e) => setConditionValue(e.target.value)}
              />
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Score Delta"
            type="number"
            min={-100}
            max={100}
            value={scoreDelta}
            onChange={(e) => setScoreDelta(e.target.value)}
            required
          />
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Status</span>
            <label className="flex items-center gap-2 h-10 text-sm text-zinc-700 dark:text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="rounded border-zinc-300 text-primary-600 focus:ring-primary-500"
              />
              Enabled
            </label>
          </div>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={() => { resetForm(); onOpenChange(false); }}>
            Cancel
          </Button>
          <Button type="submit" loading={createRule.isPending} disabled={!name.trim()}>
            Create Rule
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function EditScoringRuleDialog({
  rule,
  open,
  onOpenChange,
}: {
  rule: ScoringRule;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const updateRule = useUpdateScoringRule(rule.id);
  const [name, setName] = useState(rule.name);
  const [description, setDescription] = useState(rule.description ?? '');
  const [conditionField, setConditionField] = useState(rule.condition_field);
  const [conditionOperator, setConditionOperator] = useState(rule.condition_operator);
  const [conditionValue, setConditionValue] = useState(rule.condition_value);
  const [scoreDelta, setScoreDelta] = useState(String(rule.score_delta));
  const [enabled, setEnabled] = useState(rule.enabled);

  const needsValue = conditionOperator !== 'exists' && conditionOperator !== 'not_exists';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const delta = parseInt(scoreDelta, 10);
    if (isNaN(delta)) return;

    await updateRule.mutateAsync({
      name: name.trim(),
      description: description.trim() || undefined,
      condition_field: conditionField,
      condition_operator: conditionOperator,
      condition_value: needsValue ? conditionValue : '_',
      score_delta: delta,
      enabled,
    });

    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit Scoring Rule"
      description="Modify the condition or point value for this scoring rule."
      className="max-w-xl"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="Rule Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          autoFocus
        />
        <Input
          label="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />

        <div className="space-y-2">
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Condition</span>
          <div className="grid grid-cols-3 gap-3">
            <Select
              value={conditionField}
              onValueChange={setConditionField}
              options={CONDITION_FIELDS}
            />
            <Select
              value={conditionOperator}
              onValueChange={setConditionOperator}
              options={CONDITION_OPERATORS}
            />
            {needsValue && (
              <Input
                placeholder="Value..."
                value={conditionValue}
                onChange={(e) => setConditionValue(e.target.value)}
              />
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Score Delta"
            type="number"
            min={-100}
            max={100}
            value={scoreDelta}
            onChange={(e) => setScoreDelta(e.target.value)}
            required
          />
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Status</span>
            <label className="flex items-center gap-2 h-10 text-sm text-zinc-700 dark:text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="rounded border-zinc-300 text-primary-600 focus:ring-primary-500"
              />
              Enabled
            </label>
          </div>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" loading={updateRule.isPending} disabled={!name.trim()}>
            Save Changes
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/*  Email settings (per-user reply-to)                                 */
/* ------------------------------------------------------------------ */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function EmailSettings() {
  const { data, isLoading } = useUserSettings();
  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
      </div>
    );
  }
  // Remount (and re-seed the form) whenever the stored value changes.
  const initial = data?.data.reply_to_email ?? '';
  return <EmailSettingsForm key={initial} initial={initial} />;
}

function EmailSettingsForm({ initial }: { initial: string }) {
  const update = useUpdateUserSettings();
  const [value, setValue] = useState(initial);

  const trimmed = value.trim();
  const invalid = trimmed.length > 0 && !EMAIL_RE.test(trimmed);
  const dirty = trimmed !== initial.trim();

  const handleSave = () => {
    if (invalid) return;
    update.mutate({ reply_to_email: trimmed || null });
  };

  return (
    <div className="max-w-xl">
      <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Email</h1>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        Set a reply-to address for outreach sent on your behalf. When Bond reaches
        out to a client (for example, an email campaign you create), client replies
        go here instead of your personal inbox — so nothing lands in an unmonitored
        address.
      </p>

      <div className="mt-6">
        <label
          htmlFor="bond-reply-to"
          className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5"
        >
          Reply-to address
        </label>
        <Input
          id="bond-reply-to"
          type="email"
          placeholder="team-inbox@yourcompany.com"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        {invalid ? (
          <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">
            Enter a valid email address, or leave it blank to clear.
          </p>
        ) : (
          <p className="mt-1.5 text-xs text-zinc-400">
            Leave blank to use the default from address. Applies to new campaigns.
          </p>
        )}
      </div>

      <div className="mt-5 flex items-center gap-3">
        <Button onClick={handleSave} loading={update.isPending} disabled={invalid || !dirty}>
          Save
        </Button>
        {update.isSuccess && !dirty && (
          <span className="text-sm text-green-600 dark:text-green-400">Saved</span>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Settings page container                                            */
/* ------------------------------------------------------------------ */

const TABS = [
  { id: 'pipelines' as const, label: 'Pipelines', icon: Layers },
  { id: 'fields' as const, label: 'Custom Fields', icon: FormInput },
  { id: 'scoring' as const, label: 'Lead Scoring', icon: Star },
  { id: 'email' as const, label: 'Email', icon: Mail },
];

export function SettingsPage({ onNavigate, activeTab = 'pipelines' }: SettingsPageProps) {
  return (
    <div className="flex h-full">
      {/* Settings sidebar */}
      <div className="w-56 border-r border-zinc-100 dark:border-zinc-800 p-4 shrink-0">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 px-3 mb-3">
          Settings
        </h2>
        <nav className="space-y-0.5">
          {TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => onNavigate(`/settings/${tab.id}`)}
                className={cn(
                  'flex items-center gap-2 w-full rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-primary-50 text-primary-700 dark:bg-primary-900/30 dark:text-primary-400'
                    : 'text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800',
                )}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Settings content */}
      <div className="flex-1 p-6 overflow-y-auto">
        {activeTab === 'pipelines' && <PipelinesSettings />}
        {activeTab === 'fields' && <FieldsSettings />}
        {activeTab === 'scoring' && <ScoringSettings />}
        {activeTab === 'email' && <EmailSettings />}
      </div>
    </div>
  );
}
