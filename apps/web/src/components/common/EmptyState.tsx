interface Props {
  message: string;
}

export function EmptyState({ message }: Props) {
  return (
    <div className="empty-state">
      <p>{message}</p>
    </div>
  );
}
