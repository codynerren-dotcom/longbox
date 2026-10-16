/** Credit required wherever Metron data is shown. Cover files are separate from the data license. */
export function MetronCredit({ className = "mt-3 text-sm text-mist" }: { className?: string }) {
  return (
    <p className={className}>
      Comic data from{" "}
      <a href="https://metron.cloud/" className="text-comic" target="_blank" rel="noopener noreferrer">
        Metron
      </a>
      , licensed under{" "}
      <a href="https://creativecommons.org/licenses/by-sa/4.0/" className="text-comic" target="_blank" rel="noopener noreferrer">
        CC BY-SA 4.0
      </a>
      . Cover images belong to their publishers.
    </p>
  );
}
