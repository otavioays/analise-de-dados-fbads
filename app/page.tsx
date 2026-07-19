import CopyEverythingButton from "./CopyEverythingButton";

export default function Home() {
  return (
    <main
      style={{
        alignItems: "center",
        display: "flex",
        justifyContent: "center",
        minHeight: "100svh",
        padding: 24,
      }}
    >
      <CopyEverythingButton />
    </main>
  );
}
