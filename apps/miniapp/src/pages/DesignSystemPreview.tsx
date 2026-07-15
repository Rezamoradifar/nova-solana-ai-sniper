import { useState } from 'react';
import {
  Button,
  Card,
  Input,
  Modal,
  PnlChart,
  Skeleton,
  CardSkeleton,
  Tabs,
  TabPanel,
} from '../components/ui/index.js';

/**
 * Component showcase for Increment 1 — NOT a real screen and never wired to
 * any endpoint. Every value here is a labeled placeholder for reviewing the
 * design system in isolation (per the work order's own Step 2: "base
 * components... with no data wired yet"). The real Home screen (Increment 3+)
 * replaces this entirely once auth exists — nothing here ships as production
 * UI a user would see real numbers in.
 */
export function DesignSystemPreview() {
  const [tab, setTab] = useState('cards');
  const [modalOpen, setModalOpen] = useState(false);
  const [inputValue, setInputValue] = useState('');

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6">
      <header>
        <h1 className="text-2xl font-extrabold text-text-primary">Design System Preview</h1>
        <p className="text-sm text-text-secondary">
          Increment 1 — tokens &amp; base components only. Not a real screen.
        </p>
      </header>

      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: 'cards', label: 'Cards' },
          { value: 'inputs', label: 'Inputs' },
          { value: 'chart', label: 'Chart' },
        ]}
      >
        <TabPanel value="cards" className="mt-4 flex flex-col gap-4">
          <Card className="p-5">
            <span className="text-xs uppercase tracking-wide text-text-secondary">
              Example label
            </span>
            <p className="mt-1 text-2xl font-bold text-text-primary">—</p>
          </Card>

          <div className="flex gap-3">
            <Button variant="primary" onClick={() => {}}>
              Primary
            </Button>
            <Button variant="secondary" onClick={() => {}}>
              Secondary
            </Button>
            <Button variant="danger" onClick={() => setModalOpen(true)}>
              Danger
            </Button>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-xs uppercase tracking-wide text-text-secondary">
              Skeleton (loading state)
            </span>
            <CardSkeleton />
            <Skeleton count={3} className="h-3 w-full" />
          </div>
        </TabPanel>

        <TabPanel value="inputs" className="mt-4">
          <Card className="flex flex-col gap-4 p-5">
            <Input
              label="Example field"
              placeholder="Type something"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
            />
            <Input label="Field with an error" error="This is an example error message" />
          </Card>
        </TabPanel>

        <TabPanel value="chart" className="mt-4">
          <Card className="p-5">
            <span className="text-xs uppercase tracking-wide text-text-secondary">
              Example series (not real data)
            </span>
            <div className="mt-3">
              <PnlChart
                trend="up"
                data={Array.from({ length: 12 }, (_, i) => ({
                  timestamp: Date.now() - (11 - i) * 3_600_000,
                  value: Math.sin(i / 2) * 5 + i,
                }))}
              />
            </div>
          </Card>
        </TabPanel>
      </Tabs>

      <Modal
        open={modalOpen}
        onOpenChange={setModalOpen}
        title="Example modal"
        description="Bottom-sheet style, built on Radix Dialog."
      >
        <Button variant="secondary" onClick={() => setModalOpen(false)}>
          Close
        </Button>
      </Modal>
    </div>
  );
}
