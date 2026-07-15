import { TopBar } from '../components/TopBar.js';
import { Card } from '../components/ui/index.js';

/** Placeholder for a nav destination whose real screen hasn't been built in
 * this pass yet — not a fake/empty version of the real screen, just an
 * honest "not here yet" so the nav never dead-ends. Replaced route-by-route
 * as each screen ships. */
export function ComingSoon({ title }: { title: string }) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 sm:max-w-xl sm:gap-8">
      <TopBar title={title} />
      <Card className="p-6">
        <p className="text-sm text-text-secondary">This screen is being built next.</p>
      </Card>
    </div>
  );
}
