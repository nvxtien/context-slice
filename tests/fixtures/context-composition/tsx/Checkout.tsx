import { useState } from "react";

export function Checkout() {
  const [draft, setDraft] = useState("");

  const validate = () => draft.trim().length > 0;

  const submit = () => {
    if (validate()) {
      setDraft(draft.trim());
    }
  };

  // Shares `draft` with submit without either calling the other.
  const preview = () => `${draft.length} characters`;

  const unrelatedHelper = (label: string) => label.toUpperCase();

  return <button onClick={submit}>{unrelatedHelper(preview())}</button>;
}
