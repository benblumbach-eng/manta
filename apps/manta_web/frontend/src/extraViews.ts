import type { ComponentType } from "react";

export type ExtraViewProps = {
  datasetId: string;
  onClose: () => void;
  onOpenAsv: (id: string) => void;
};

export type ExtraView = {
  key: string;
  testid: string;
  label: string;
  icon: string;
  title: string;
  errorLabel: string;
  width: number;
  Panel: ComponentType<ExtraViewProps>;
};

export const EXTRA_VIEWS: ExtraView[] = [
];

export const extraKind = (key: string) => `view:${key}` as const;
