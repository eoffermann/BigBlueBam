import { useEffect, useState } from 'react';
import { Dialog } from '@/components/common/dialog';
import { Input } from '@/components/common/input';
import { Button } from '@/components/common/button';
import { Select } from '@/components/common/select';
import { useUpdateCompany, type Company } from '@/hooks/use-companies';

const SIZE_OPTIONS = [
  { value: '1-10', label: '1-10' },
  { value: '11-50', label: '11-50' },
  { value: '51-200', label: '51-200' },
  { value: '201-1000', label: '201-1000' },
  { value: '1001-5000', label: '1001-5000' },
  { value: '5000+', label: '5000+' },
];

interface EditCompanyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  company: Company;
  onSuccess?: () => void;
}

export function EditCompanyDialog({ open, onOpenChange, company, onSuccess }: EditCompanyDialogProps) {
  const [name, setName] = useState(company.name);
  const [domain, setDomain] = useState(company.domain ?? '');
  const [industry, setIndustry] = useState(company.industry ?? '');
  const [sizeBucket, setSizeBucket] = useState(company.size_bucket ?? '');
  const [website, setWebsite] = useState(company.website ?? '');
  const [phone, setPhone] = useState(company.phone ?? '');
  const updateCompany = useUpdateCompany(company.id);

  useEffect(() => {
    if (open) {
      setName(company.name);
      setDomain(company.domain ?? '');
      setIndustry(company.industry ?? '');
      setSizeBucket(company.size_bucket ?? '');
      setWebsite(company.website ?? '');
      setPhone(company.phone ?? '');
    }
  }, [open, company]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    // The API update schema is `.optional()`-only (not nullable): omit empty
    // fields rather than sending null, which Zod would reject.
    await updateCompany.mutateAsync({
      name: name.trim(),
      domain: domain.trim() || undefined,
      industry: industry.trim() || undefined,
      size_bucket: sizeBucket || undefined,
      website: website.trim() || undefined,
      phone: phone.trim() || undefined,
    });

    onOpenChange(false);
    onSuccess?.();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit Company"
      description="Update this company's details."
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="Company Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          autoFocus
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Domain"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          />
          <Input
            label="Industry"
            value={industry}
            onChange={(e) => setIndustry(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Select
            label="Company Size"
            value={sizeBucket}
            onValueChange={setSizeBucket}
            options={SIZE_OPTIONS}
            placeholder="Select size..."
          />
          <Input
            label="Website"
            placeholder="https://..."
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
          />
        </div>
        <Input
          label="Phone"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        <div className="flex justify-end gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" loading={updateCompany.isPending}>
            Save Changes
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
