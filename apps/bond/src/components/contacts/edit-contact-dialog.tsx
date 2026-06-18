import { useEffect, useState } from 'react';
import { Dialog } from '@/components/common/dialog';
import { Input } from '@/components/common/input';
import { Button } from '@/components/common/button';
import { Select } from '@/components/common/select';
import { useUpdateContact, type Contact } from '@/hooks/use-contacts';

const LIFECYCLE_OPTIONS = [
  { value: 'lead', label: 'Lead' },
  { value: 'subscriber', label: 'Subscriber' },
  { value: 'marketing_qualified', label: 'MQL' },
  { value: 'sales_qualified', label: 'SQL' },
  { value: 'opportunity', label: 'Opportunity' },
  { value: 'customer', label: 'Customer' },
  { value: 'evangelist', label: 'Evangelist' },
  { value: 'other', label: 'Other' },
];

interface EditContactDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact: Contact;
  onSuccess?: () => void;
}

export function EditContactDialog({ open, onOpenChange, contact, onSuccess }: EditContactDialogProps) {
  const [firstName, setFirstName] = useState(contact.first_name ?? '');
  const [lastName, setLastName] = useState(contact.last_name ?? '');
  const [email, setEmail] = useState(contact.email ?? '');
  const [phone, setPhone] = useState(contact.phone ?? '');
  const [title, setTitle] = useState(contact.title ?? '');
  const [lifecycleStage, setLifecycleStage] = useState(contact.lifecycle_stage);
  const updateContact = useUpdateContact(contact.id);

  useEffect(() => {
    if (open) {
      setFirstName(contact.first_name ?? '');
      setLastName(contact.last_name ?? '');
      setEmail(contact.email ?? '');
      setPhone(contact.phone ?? '');
      setTitle(contact.title ?? '');
      setLifecycleStage(contact.lifecycle_stage);
    }
  }, [open, contact]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName.trim() && !lastName.trim() && !email.trim()) return;

    // The API update schema is `.optional()`-only (not nullable): omit empty
    // fields rather than sending null, which Zod would reject.
    await updateContact.mutateAsync({
      first_name: firstName.trim() || undefined,
      last_name: lastName.trim() || undefined,
      email: email.trim() || undefined,
      phone: phone.trim() || undefined,
      title: title.trim() || undefined,
      lifecycle_stage: lifecycleStage,
    });

    onOpenChange(false);
    onSuccess?.();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit Contact"
      description="Update this contact's details."
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="First Name"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            autoFocus
          />
          <Input
            label="Last Name"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
          />
        </div>
        <Input
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <Input
            label="Job Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <Select
          label="Lifecycle Stage"
          value={lifecycleStage}
          onValueChange={setLifecycleStage}
          options={LIFECYCLE_OPTIONS}
        />
        <div className="flex justify-end gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" loading={updateContact.isPending}>
            Save Changes
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
