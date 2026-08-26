module vcd_heavy_bench;
  integer i;
  reg [127:0] bus;
  reg clock;

  initial begin
    bus = 128'h0123456789abcdef_0011223344556677;
    clock = 0;
    $dumpfile("wave.vcd");
    $dumpvars(0, vcd_heavy_bench);
    for (i = 0; i < 10000; i = i + 1) begin
      #1;
      clock = ~clock;
      bus = {bus[126:0], bus[127] ^ bus[125] ^ bus[100] ^ bus[98]};
    end
    if ((^bus) === 1'bx)
      $display("FAIL vcd-heavy");
    else
      $display("PASS vcd-heavy");
    $finish;
  end
endmodule
