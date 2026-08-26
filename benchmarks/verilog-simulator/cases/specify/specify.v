module specify_buffer(input source, output destination);
  buf (destination, source);
  specify
    specparam rise_delay = 1, fall_delay = 1;
    (source => destination) = (rise_delay, fall_delay);
  endspecify
endmodule

module specify_bench;
  integer i;
  reg source;
  wire destination;

  specify_buffer dut(.source(source), .destination(destination));

  initial begin
    source = 0;
    for (i = 0; i < 20000; i = i + 1) begin
      source = i[0];
      #1;
      if (destination !== source) begin
        $display("FAIL specify");
        $finish;
      end
    end
    $display("PASS specify");
    $finish;
  end
endmodule
