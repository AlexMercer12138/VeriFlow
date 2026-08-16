module counter;
  reg clock;
  integer count;

  initial begin
    clock = 0;
    count = 0;
    $dumpfile("counter.vcd");
    $dumpvars(0, counter);
  end

  always #1 clock = ~clock;

  always @(posedge clock) begin
    count = count + 1;
    if (count == 4) begin
      $display("PASS");
      $finish;
    end
  end
endmodule
